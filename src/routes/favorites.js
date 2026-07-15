// This file handles the interactions that are related favorite recipes or dishes
// Collect data and store at either favorite table or recipe table
// Delete and add favorite dishes or recipes

import express from "express";
import { v2 as cloudinary } from "cloudinary";
import { db } from "../config/db.js";
import { recipesTable, favouritesTable } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { requireClerkAuth, ensureClerkIdMatch, attachUserFromAuth } from "../middleware/auth.js";
import { ENV } from "../config/env.js";

const favoritesRoutes = express.Router();

// Recipe photo upload (Cloudinary). recipesTable.image only ever stores a URL —
// the actual bytes are hosted here, matching every other image in this app
// (FatSecret, TheMealDB, ingredient icons all point off-box too).
const MAX_IMAGE_BASE64_CHARS = 8_000_000; // ~6MB decoded, same cap as food-recognition proxy
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

const requireCloudinaryConfig = () => {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = ENV;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    const error = new Error("Image upload is not configured.");
    error.status = 503;
    throw error;
  }
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
  });
};

const validateImageDataUri = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    const error = new Error("imageBase64 is required.");
    error.status = 400;
    throw error;
  }
  if (raw.length > MAX_IMAGE_BASE64_CHARS) {
    const error = new Error("Image is too large.");
    error.status = 413;
    throw error;
  }

  const match = raw.match(/^data:([^;,]+);base64,([\s\S]+)$/);
  if (!match) {
    const error = new Error("imageBase64 must be a data URI (data:<mime>;base64,...).");
    error.status = 400;
    throw error;
  }

  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    const error = new Error("Unsupported image type. Use JPEG, PNG, or WebP.");
    error.status = 415;
    throw error;
  }

  return raw;
};

const normalizeExternalId = (item = {}) => {
  const rawId = item.externalId ?? item.id ?? item.foodId;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== "") {
    return String(rawId);
  }

  const title = String(item.title || item.foodName || "item")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  return `title:${title}`;
};

// Records where a favorite came from so the detail screen can tell a recipe apart
// from a plain food after a round-trip. Recipes carry a `source`/`type` containing
// "recipe" or a `recipe_id`; anything else is treated as a food.
const normalizeFavoriteSource = (item = {}) => {
  const raw = String(item.source || item.type || "").trim().toLowerCase();
  if (raw.includes("recipe")) return "fatsecret_recipe";
  if (raw.includes("food")) return "fatsecret_food";
  if (item.recipe_id || item.recipeId) return "fatsecret_recipe";
  return raw || null;
};

const normalizeFavoriteItem = (item = {}) => ({
  externalId: normalizeExternalId(item),
  title: item.title || item.foodName || "Untitled Item",
  image: item.image || "",
  calories: Number(item.calories) || 0,
  protein: Number(item.protein) || 0,
  carbs: Number(item.carbs) || 0,
  fats: Number(item.fats) || 0,
  cookTime: item.time || "",
  servings: Number(item.servings) || 1,
  source: normalizeFavoriteSource(item),
});

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

// Mutation routes only accept positive integer database ids. Returning 400 for a
// malformed id avoids passing untrusted text into an integer-column comparison.
const parsePositiveIntegerId = (value) => {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

// 1. SAVE CUSTOM RECIPE (Used by your Recipe Detail Page)
favoritesRoutes.post("/save-custom", requireClerkAuth, ensureClerkIdMatch("body"), attachUserFromAuth, async (req, res) => {
  try {
    const { 
        clerkId, externalId, title, image, 
        prepTime, cookTime, servings, 
        calories, protein, carbs, fats, 
        ingredients, instructions 
    } = req.body;

    const userId = req.dbUser.userId;

    // Insert into 'recipes' table (The one with JSON support)
    await db.insert(recipesTable).values({
        userId,
        externalId: String(externalId),
        title,
        image,
        prepTime: prepTime || 0,
        cookTime: cookTime || 0,
        servings: servings || 1,
        calories: toNumber(calories),
        protein: toNumber(protein),
        carbs: toNumber(carbs),
        fats: toNumber(fats),
        ingredients: ingredients, // Saves the array as JSON
        instructions: instructions // Saves the array as JSON
    });

    res.status(201).json({ success: true, message: "Recipe saved" });

  } catch (error) {
    console.error("Save Custom Recipe Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// 1B. UPLOAD RECIPE PHOTO (Used by the Recipe Detail Page's create/edit hero image)
favoritesRoutes.post("/upload-image", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    requireCloudinaryConfig();
    const dataUri = validateImageDataUri(req.body?.imageBase64);

    const uploadResult = await cloudinary.uploader.upload(dataUri, {
      folder: "goodhealthmate/recipes",
      resource_type: "image",
    });

    res.status(200).json({ url: uploadResult.secure_url });
  } catch (error) {
    console.error("Recipe image upload error:", error);
    res.status(error.status || 500).json({ error: error.message || "Image upload failed." });
  }
});

// 2. TOGGLE STANDARD FAVORITE (For the Heart Icon on the Grid Page)
favoritesRoutes.post("/toggle", requireClerkAuth, ensureClerkIdMatch("body"), attachUserFromAuth, async (req, res) => {
  try {
    // We expect 'item' to contain food details
    const { clerkId, item } = req.body;
    
    const userId = req.dbUser.userId;
    const normalizedItem = normalizeFavoriteItem(item || {});

    // Check if it exists (using externalId)
    const existing = await db.select().from(favouritesTable).where(and(
      eq(favouritesTable.userId, userId),
      eq(favouritesTable.externalId, normalizedItem.externalId)
    ));

    if (existing.length > 0) {
      // UNLIKE: Remove it
      await db.delete(favouritesTable).where(eq(favouritesTable.id, existing[0].id));
      res.status(200).json({ isFavorite: false, message: "Removed from favorites" });
    } else {
      // LIKE: Add it with Macros
      await db.insert(favouritesTable).values({
        userId,
        externalId: normalizedItem.externalId,
        title: normalizedItem.title,
        image: normalizedItem.image,
        calories: normalizedItem.calories,
        protein: normalizedItem.protein,
        carbs: normalizedItem.carbs,
        fats: normalizedItem.fats,
        cookTime: normalizedItem.cookTime,
        servings: normalizedItem.servings,
        source: normalizedItem.source,
      });
      res.status(201).json({ isFavorite: true, message: "Added to favorites" });
    }
  } catch (error) {
    console.error("Toggle Favorite Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// 3. SAVE ALL ITEMS OF A COMBO TO FAVORITES (idempotent add)
favoritesRoutes.post("/save-combo", requireClerkAuth, ensureClerkIdMatch("body"), attachUserFromAuth, async (req, res) => {
  try {
    const { clerkId, items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No combo items supplied" });
    }

    const userId = req.dbUser.userId;

    let savedCount = 0;
    let skippedCount = 0;

    for (const rawItem of items) {
      const item = normalizeFavoriteItem(rawItem || {});

      const existing = await db.select().from(favouritesTable).where(and(
        eq(favouritesTable.userId, userId),
        eq(favouritesTable.externalId, item.externalId)
      )).limit(1);

      if (existing.length > 0) {
        skippedCount += 1;
        continue;
      }

      await db.insert(favouritesTable).values({
        userId,
        externalId: item.externalId,
        title: item.title,
        image: item.image,
        calories: item.calories,
        protein: item.protein,
        carbs: item.carbs,
        fats: item.fats,
        cookTime: item.cookTime,
        servings: item.servings,
        source: item.source,
      });
      savedCount += 1;
    }

    return res.status(200).json({
      success: true,
      savedCount,
      skippedCount,
      message: "Combo items saved to favorites",
    });
  } catch (error) {
    console.error("Save Combo Favorites Error:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

// 4. CHECK FAVORITE STATUS
favoritesRoutes.get("/check/:clerkId/:recipeId", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
    try {
      const { clerkId, recipeId } = req.params;
      const userId = req.dbUser.userId;
  
      const existing = await db.select().from(favouritesTable).where(and(
          eq(favouritesTable.userId, userId),
          eq(favouritesTable.externalId, String(recipeId))
      ));
  
      res.json({ isFavorite: existing.length > 0 });
    } catch (error) {
      res.json({ isFavorite: false });
    }
});

// 5. GET ALL FAVORITES (Separated by type)
favoritesRoutes.get("/list/:clerkId", requireClerkAuth, ensureClerkIdMatch("params"), attachUserFromAuth, async (req, res) => {
  try {
    const { clerkId } = req.params;

    const userId = req.dbUser.userId;

    // 2. Fetch Simple Favorites (Hearted items from Grid)
    const favFoods = await db
        .select()
        .from(favouritesTable)
        .where(eq(favouritesTable.userId, userId));

    // 3. Fetch Saved Custom Recipes (Full details from Detail Page)
    const savedRecipes = await db
        .select({
            id: recipesTable.id,
            title: recipesTable.title,
            calories: recipesTable.calories,
            image: recipesTable.image,
            // We select just enough info for the list card
        })
        .from(recipesTable)
        .where(eq(recipesTable.userId, userId));

    res.json({
        favoriteFoods: favFoods,
        savedRecipes: savedRecipes
    });

  } catch (error) {
    console.error("Fetch Favorites Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// 6. DELETE FAVORITE FOOD (Simple Item)
favoritesRoutes.delete("/delete-food/:id", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const favoriteId = parsePositiveIntegerId(req.params.id);
    if (!favoriteId) return res.status(400).json({ error: "Invalid favorite id" });

    const deleted = await db
      .delete(favouritesTable)
      .where(and(eq(favouritesTable.id, favoriteId), eq(favouritesTable.userId, req.dbUser.userId)))
      .returning();

    // DELETE is idempotent: a duplicate request is successful when the requested
    // end state (the user's favorite is absent) has already been reached.
    res.status(200).json({
      success: true,
      deleted: deleted.length > 0,
      alreadyAbsent: deleted.length === 0,
      message: deleted.length > 0 ? "Food removed from favorites" : "Favorite was already removed",
    });
  } catch (error) {
    console.error("Delete Food Error:", error);
    res.status(500).json({ error: "Failed to delete food" });
  }
});

// 7. DELETE SAVED RECIPE (Custom Detailed Recipe)
favoritesRoutes.delete("/delete-recipe/:id", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const recipeId = parsePositiveIntegerId(req.params.id);
    if (!recipeId) return res.status(400).json({ error: "Invalid recipe id" });

    const deleted = await db
      .delete(recipesTable)
      .where(and(eq(recipesTable.id, recipeId), eq(recipesTable.userId, req.dbUser.userId)))
      .returning();

    res.status(200).json({
      success: true,
      deleted: deleted.length > 0,
      alreadyAbsent: deleted.length === 0,
      message: deleted.length > 0 ? "Recipe deleted" : "Recipe was already removed",
    });
  } catch (error) {
    console.error("Delete Recipe Error:", error);
    res.status(500).json({ error: "Failed to delete recipe" });
  }
});

// 8. GET FULL CUSTOM RECIPE DETAILS (For Editing)
favoritesRoutes.get("/custom/:id", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const recipe = await db
      .select()
      .from(recipesTable)
      .where(and(eq(recipesTable.id, id), eq(recipesTable.userId, req.dbUser.userId)));

    if (recipe.length === 0) return res.status(404).json({ error: "Recipe not found" });
    
    res.json(recipe[0]);
  } catch (error) {
    console.error("Get Custom Recipe Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// 9. UPDATE CUSTOM RECIPE
favoritesRoutes.put("/update-recipe/:id", requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, calories, protein, carbs, fats, servings, ingredients, instructions, image } = req.body;

    const updateValues = {
      title,
      calories: toNumber(calories),
      ingredients,
      instructions,
    };
    // Persist edited macros / serving count when the client sends them, so the
    // redesigned editable nutrition card round-trips on update (not just create).
    if (protein !== undefined) updateValues.protein = toNumber(protein);
    if (carbs !== undefined) updateValues.carbs = toNumber(carbs);
    if (fats !== undefined) updateValues.fats = toNumber(fats);
    if (servings !== undefined) updateValues.servings = Number(servings) || 1;
    // Only touch the image column when the client actually sent one, so an
    // edit that doesn't include a photo never wipes out an existing image.
    if (image !== undefined) {
      updateValues.image = image;
    }

    const updated = await db.update(recipesTable)
      .set(updateValues)
      .where(and(eq(recipesTable.id, id), eq(recipesTable.userId, req.dbUser.userId)))
      .returning();

    if (updated.length === 0) {
      return res.status(404).json({ error: "Recipe not found" });
    }

    res.status(200).json({ success: true, message: "Recipe updated" });
  } catch (error) {
    console.error("Update Recipe Error:", error);
    res.status(500).json({ error: "Failed to update" });
  }
});

export default favoritesRoutes;


