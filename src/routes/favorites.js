// This file handles the interactions that are related favorite recipes or dishes
// Collect data and store at either favorite table or recipe table
// Delete and add favorite dishes or recipes

import express from "express";
import { db } from "../config/db.js";
import { usersTable, recipesTable, favouritesTable } from "../db/schema.js";
import { eq, and } from "drizzle-orm";

const favoritesRoutes = express.Router();

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
});

// 1. SAVE CUSTOM RECIPE (Used by your Recipe Detail Page)
favoritesRoutes.post("/save-custom", async (req, res) => {
  try {
    const { 
        clerkId, externalId, title, image, 
        prepTime, cookTime, servings, 
        calories, protein, carbs, fats, 
        ingredients, instructions 
    } = req.body;

    // Get User ID
    const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
    if (user.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = user[0].userId;

    // Insert into 'recipes' table (The one with JSON support)
    await db.insert(recipesTable).values({
        userId,
        externalId: String(externalId),
        title,
        image,
        prepTime: prepTime || 0,
        cookTime: cookTime || 0,
        servings: servings || 1,
        calories: calories || 0,
        protein: protein || 0,
        carbs: carbs || 0,
        fats: fats || 0,
        ingredients: ingredients, // Saves the array as JSON
        instructions: instructions // Saves the array as JSON
    });

    res.status(201).json({ success: true, message: "Recipe saved" });

  } catch (error) {
    console.error("Save Custom Recipe Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// 2. TOGGLE STANDARD FAVORITE (For the Heart Icon on the Grid Page)
favoritesRoutes.post("/toggle", async (req, res) => {
  try {
    // We expect 'item' to contain food details
    const { clerkId, item } = req.body;
    
    const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
    if (user.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = user[0].userId;
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
      });
      res.status(201).json({ isFavorite: true, message: "Added to favorites" });
    }
  } catch (error) {
    console.error("Toggle Favorite Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// 3. SAVE ALL ITEMS OF A COMBO TO FAVORITES (idempotent add)
favoritesRoutes.post("/save-combo", async (req, res) => {
  try {
    const { clerkId, items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No combo items supplied" });
    }

    const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
    if (user.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = user[0].userId;

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
favoritesRoutes.get("/check/:clerkId/:recipeId", async (req, res) => {
    try {
      const { clerkId, recipeId } = req.params;
      const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
      if (user.length === 0) return res.json({ isFavorite: false });
      const userId = user[0].userId;
  
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
favoritesRoutes.get("/list/:clerkId", async (req, res) => {
  try {
    const { clerkId } = req.params;

    // 1. Get User ID
    const user = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
    if (user.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = user[0].userId;

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
favoritesRoutes.delete("/delete-food/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(favouritesTable).where(eq(favouritesTable.id, id));
    res.status(200).json({ success: true, message: "Food removed from favorites" });
  } catch (error) {
    console.error("Delete Food Error:", error);
    res.status(500).json({ error: "Failed to delete food" });
  }
});

// 7. DELETE SAVED RECIPE (Custom Detailed Recipe)
favoritesRoutes.delete("/delete-recipe/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(recipesTable).where(eq(recipesTable.id, id));
    res.status(200).json({ success: true, message: "Recipe deleted" });
  } catch (error) {
    console.error("Delete Recipe Error:", error);
    res.status(500).json({ error: "Failed to delete recipe" });
  }
});

// 8. GET FULL CUSTOM RECIPE DETAILS (For Editing)
favoritesRoutes.get("/custom/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const recipe = await db.select().from(recipesTable).where(eq(recipesTable.id, id));
    
    if (recipe.length === 0) return res.status(404).json({ error: "Recipe not found" });
    
    res.json(recipe[0]);
  } catch (error) {
    console.error("Get Custom Recipe Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// 9. UPDATE CUSTOM RECIPE
favoritesRoutes.put("/update-recipe/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, ingredients, instructions } = req.body; // We mainly update these

    await db.update(recipesTable)
      .set({ 
        title, 
        ingredients, 
        instructions,
        // You can add macro updates here if you recalculate them
      })
      .where(eq(recipesTable.id, id));

    res.status(200).json({ success: true, message: "Recipe updated" });
  } catch (error) {
    console.error("Update Recipe Error:", error);
    res.status(500).json({ error: "Failed to update" });
  }
});

export default favoritesRoutes;


