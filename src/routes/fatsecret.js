import express from "express";

import {
  getFoodItemById,
  getRecipeDetails,
  searchFoodItems,
  searchRecipes,
  serializeFatSecretError,
} from "../services/mealAPI.js";

const fatSecretRoutes = express.Router();
const DEFAULT_RECIPE_SEARCH_QUERY = "healthy";

const parseMaxResults = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(25, parsed));
};

const parseExpectedCalories = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const respondWithFatSecretError = (res, error) => {
  const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : 502;
  return res.status(status).json(serializeFatSecretError(error));
};

fatSecretRoutes.get("/foods/search", async (req, res) => {
  try {
    const query = String(req.query.query || req.query.q || "").trim();
    const maxResults = parseMaxResults(req.query.maxResults, 10);
    if (!query) {
      return res.status(400).json({ error: "Missing query parameter." });
    }

    const items = await searchFoodItems(query, maxResults, { throwOnError: true });
    return res.status(200).json({ items });
  } catch (error) {
    console.error("FatSecret food search route error:", error);
    return respondWithFatSecretError(res, error);
  }
});

fatSecretRoutes.get("/foods/:foodId", async (req, res) => {
  try {
    const foodId = String(req.params.foodId || "").trim();
    if (!foodId) {
      return res.status(400).json({ error: "Missing foodId parameter." });
    }

    const expectedCalories = parseExpectedCalories(req.query.expectedCalories);
    const item = await getFoodItemById(foodId, {
      expectedCalories,
      throwOnError: true,
    });
    if (!item) {
      return res.status(404).json({ error: "Food item not found." });
    }

    return res.status(200).json({ item });
  } catch (error) {
    console.error("FatSecret food detail route error:", error);
    return respondWithFatSecretError(res, error);
  }
});

fatSecretRoutes.get("/recipes/search", async (req, res) => {
  try {
    const query =
      String(req.query.query || req.query.q || DEFAULT_RECIPE_SEARCH_QUERY).trim() ||
      DEFAULT_RECIPE_SEARCH_QUERY;
    const maxResults = parseMaxResults(req.query.maxResults, 15);

    const items = await searchRecipes(query, maxResults, { throwOnError: true });
    return res.status(200).json({ items });
  } catch (error) {
    console.error("FatSecret recipe search route error:", error);
    return respondWithFatSecretError(res, error);
  }
});

fatSecretRoutes.get("/recipes/:recipeId", async (req, res) => {
  try {
    const recipeId = String(req.params.recipeId || "").trim();
    if (!recipeId) {
      return res.status(400).json({ error: "Missing recipeId parameter." });
    }

    const item = await getRecipeDetails(recipeId, { throwOnError: true });
    if (!item) {
      return res.status(404).json({ error: "Recipe not found." });
    }

    return res.status(200).json({ item });
  } catch (error) {
    console.error("FatSecret recipe detail route error:", error);
    return respondWithFatSecretError(res, error);
  }
});

export default fatSecretRoutes;
