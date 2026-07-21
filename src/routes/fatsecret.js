import express from "express";

import {
  getFoodItemById,
  getRecipeDetails,
  hasCachedFoodDetail,
  hasCachedFoodSearch,
  hasCachedRecipeDetail,
  hasCachedRecipeSearch,
  searchFoodItems,
  searchRecipes,
  serializeFatSecretError,
} from "../services/mealAPI.js";

const fatSecretRoutes = express.Router();
const DEFAULT_RECIPE_SEARCH_QUERY = "healthy";

// Food/recipe detail rows in FatSecret are effectively immutable, so iOS
// NSURLCache can hold them for a full day. Search results can change over time
// but rarely within minutes — a 10-minute window safely absorbs repeated
// keystrokes and rapid screen revisits without serving stale data.
const FOOD_DETAIL_CACHE_HEADER = "public, max-age=86400";
const SEARCH_RESULT_CACHE_HEADER = "public, max-age=600";

const parseMaxResults = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(25, parsed));
};

const parseExpectedCalories = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

// Rate-limiter cache probe (mounted in server.js BEFORE fatSecretLimiter): a
// request the backend apiCache can already answer costs no FatSecret quota, so
// it is routed to the generous cachedContentLimiter instead of the tight
// per-IP FatSecret bucket. Without this, image hydration and screen revisits
// were charged full price for ~0ms cache reads and starved genuinely new
// lookups (ERROR_LOG Error 065). Parsing here MUST mirror the route handlers
// below — each branch reuses the same helpers the handler uses.
const decodePathSegment = (value) => {
  try {
    return decodeURIComponent(String(value || "")).trim();
  } catch {
    return String(value || "").trim();
  }
};

export const canServeFatSecretRequestFromCache = (req) => {
  // req.path is relative to the /api/fatsecret mount point.
  const path = String(req.path || "");

  if (path === "/foods/search") {
    const query = String(req.query.query || req.query.q || "").trim();
    const maxResults = parseMaxResults(req.query.maxResults, 10);
    if (!query) return true; // handler 400s without fetching
    const foodType = String(req.query.foodType || req.query.food_type || "").trim().toLowerCase();
    return hasCachedFoodSearch({ query, maxResults, foodType }, maxResults);
  }

  if (path === "/recipes/search") {
    const query =
      String(req.query.query || req.query.q || DEFAULT_RECIPE_SEARCH_QUERY).trim() ||
      DEFAULT_RECIPE_SEARCH_QUERY;
    const maxResults = parseMaxResults(req.query.maxResults, 15);
    return hasCachedRecipeSearch(query, maxResults);
  }

  const foodMatch = path.match(/^\/foods\/([^/]+)$/);
  if (foodMatch) {
    return hasCachedFoodDetail(decodePathSegment(foodMatch[1]), parseExpectedCalories(req.query.expectedCalories));
  }

  const recipeMatch = path.match(/^\/recipes\/([^/]+)$/);
  if (recipeMatch) {
    return hasCachedRecipeDetail(decodePathSegment(recipeMatch[1]));
  }

  // Unknown shape (404s in this router) — cheap either way.
  return true;
};

const respondWithFatSecretError = (res, error) => {
  const errorCode = String(error?.code ?? error?.details?.code ?? "");
  const status = errorCode === "106"
    ? 404
    : Number.isFinite(Number(error?.status)) ? Number(error.status) : 502;
  return res.status(status).json(serializeFatSecretError(error));
};

fatSecretRoutes.get("/foods/search", async (req, res) => {
  try {
    const query = String(req.query.query || req.query.q || "").trim();
    const maxResults = parseMaxResults(req.query.maxResults, 10);
    if (!query) {
      return res.status(400).json({ error: "Missing query parameter." });
    }

    const foodType = String(req.query.foodType || req.query.food_type || "").trim().toLowerCase();
    const items = await searchFoodItems({ query, maxResults, foodType }, maxResults, { throwOnError: true });
    res.set("Cache-Control", SEARCH_RESULT_CACHE_HEADER);
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

    res.set("Cache-Control", FOOD_DETAIL_CACHE_HEADER);
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
    res.set("Cache-Control", SEARCH_RESULT_CACHE_HEADER);
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

    res.set("Cache-Control", FOOD_DETAIL_CACHE_HEADER);
    return res.status(200).json({ item });
  } catch (error) {
    console.error("FatSecret recipe detail route error:", error);
    return respondWithFatSecretError(res, error);
  }
});

export default fatSecretRoutes;
