import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ENV } from "../config/env.js";
import { createTtlCache } from "../utils/ttlCache.js";

// Precomputed list of the ~29 cuisines that actually have recipes (with counts).
// TheMealDB's a=list returns ~192 geographic countries but most are empty, so we
// serve this committed file instead of the raw list. Regenerate with:
//   node scripts/build-themealdb-areas.js
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loadAreasWithRecipes = () => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "data", "themealdb_areas.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.areas) ? parsed.areas : [];
  } catch (e) {
    console.warn("[themealdb] could not load themealdb_areas.json:", e.message);
    return [];
  }
};
const AREAS_WITH_RECIPES = loadAreasWithRecipes();

// Precomputed per-recipe nutrition (offline, from USDA + curated overrides).
// Keyed by recipe id; totals are for the WHOLE recipe. Regenerate with:
//   python tools/themealdb_nutrition/compute_nutrition.py
const loadNutrition = () => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "..", "data", "themealdb_nutrition.json"), "utf8");
    return JSON.parse(raw).recipes || {};
  } catch (e) {
    console.warn("[themealdb] could not load themealdb_nutrition.json:", e.message);
    return {};
  }
};
const NUTRITION = loadNutrition();

// TheMealDB hosts its own ingredient thumbnails. Because TheMealDB recipes carry
// TheMealDB ingredient names, these match almost perfectly (far better coverage
// than our curated set, which uses different names e.g. "arugula" vs "Rocket").
const ingredientImageUrl = (name) =>
  `https://www.themealdb.com/images/ingredients/${encodeURIComponent(name)}-small.png`;

// TheMealDB browse-by-cuisine proxy (Phase 1 of the recipe integration).
// The premier key stays server-side; clients hit /api/themealdb/*. TheMealDB
// content is near-static, so responses are cached aggressively.
//
// Phase 2 will fill in `nutrition` (computed from ingredients via USDA). For now
// recipe nutrition is returned as an "estimate pending" placeholder.

const themealdbRoutes = express.Router();

const API_BASE = () => {
  const key = String(ENV.MEALDB_API_KEY || "1").trim() || "1";
  const version = key === "1" ? "v1" : "v2";
  return `https://www.themealdb.com/api/json/${version}/${key}`;
};

const LIST_CACHE = createTtlCache({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 500 });   // areas / by-area
const RECIPE_CACHE = createTtlCache({ ttlMs: 7 * 24 * 60 * 60 * 1000, maxEntries: 2000 });
const LIST_CACHE_HEADER = "public, max-age=86400";
const RECIPE_CACHE_HEADER = "public, max-age=604800";

const REQUEST_TIMEOUT_MS = 12000;

const fetchMealDb = async (path) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${API_BASE()}/${path}`, {
      signal: controller.signal,
      headers: { "User-Agent": "GoodHealthMate/1.0" },
    });
    if (!resp.ok) {
      const err = new Error(`TheMealDB HTTP ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
};

const ensureArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

// TheMealDB meals carry strIngredient1..20 / strMeasure1..20 pairs.
const extractIngredients = (meal) => {
  const out = [];
  for (let i = 1; i <= 20; i += 1) {
    const name = String(meal[`strIngredient${i}`] || "").trim();
    const measure = String(meal[`strMeasure${i}`] || "").trim();
    if (name) out.push({ name, measure, image: ingredientImageUrl(name) });
  }
  return out;
};

// TheMealDB instruction text often contains standalone "STEP 1" / "Step 2:" label
// lines (and sometimes prefixes the step text with the label). Drop label-only
// lines and strip leading labels so each step is real content.
const STEP_LABEL_RE = /^step\s*\d+\s*[:.)-]?$/i;
const STEP_PREFIX_RE = /^step\s*\d+\s*[:.)-]?\s*/i;
const splitInstructions = (text) => {
  const lines = String(text || "")
    .split(/\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const steps = [];
  for (const line of lines) {
    if (STEP_LABEL_RE.test(line)) continue; // a bare "Step 1" label
    const cleaned = line.replace(STEP_PREFIX_RE, "").trim();
    if (cleaned) steps.push(cleaned);
  }
  return steps.length ? steps : lines;
};

// Map a TheMealDB lookup meal to the unified recipe model the app renders.
const toUnifiedRecipe = (meal) => ({
  source: "themealdb",
  id: String(meal.idMeal),
  title: meal.strMeal || "",
  image: meal.strMealThumb || "",
  cuisine: meal.strArea || "",
  category: meal.strCategory || "",
  tags: meal.strTags ? String(meal.strTags).split(",").map((t) => t.trim()).filter(Boolean) : [],
  youtube: meal.strYoutube || "",
  source_url: meal.strSource || "",
  ingredients: extractIngredients(meal),
  instructions: splitInstructions(meal.strInstructions),
  nutrition: nutritionFor(meal.idMeal, meal.strCategory),
});

// Estimated grams for ONE serving, by TheMealDB category. TheMealDB has no
// servings count at all, so this is a heuristic: totalGrams (summed from every
// ingredient's parsed measure, see compute_nutrition.py) divided by a typical
// per-serving weight for that kind of dish. Category is only available from the
// live per-recipe API call (not the offline dataset), so this estimate is
// computed here at request time rather than baked into themealdb_nutrition.json.
const CATEGORY_SERVING_GRAMS = {
  dessert: 110,
  starter: 130,
  side: 130,
  breakfast: 250,
  vegetarian: 300,
  vegan: 300,
  seafood: 300,
  pasta: 350,
  miscellaneous: 350,
  chicken: 350,
  beef: 400,
  lamb: 400,
  pork: 400,
  goat: 400,
};
const DEFAULT_SERVING_GRAMS = 350; // unrecognised category -> assume a hearty main
const MIN_SERVINGS = 1;
const MAX_SERVINGS = 12;
const PLAUSIBLE_KCAL_PER_SERVING = { min: 150, max: 900 };
const FALLBACK_KCAL_PER_SERVING = 550;

// Estimate a whole recipe's servings from its total mass + category, with a
// calorie-per-serving sanity check so an odd mass estimate (bad source measures,
// low ingredient coverage) can't produce an absurd serving count.
const estimateServings = (totalGrams, totalCalories, category) => {
  const grams = Number(totalGrams) || 0;
  if (grams <= 0) return null;

  const key = String(category || "").trim().toLowerCase();
  const gramsPerServing = CATEGORY_SERVING_GRAMS[key] || DEFAULT_SERVING_GRAMS;
  let servings = Math.round(grams / gramsPerServing) || 1;

  const kcal = Number(totalCalories) || 0;
  const kcalPerServing = servings > 0 ? kcal / servings : 0;
  if (kcal > 0 && (kcalPerServing < PLAUSIBLE_KCAL_PER_SERVING.min || kcalPerServing > PLAUSIBLE_KCAL_PER_SERVING.max)) {
    servings = Math.round(kcal / FALLBACK_KCAL_PER_SERVING) || 1;
  }

  return Math.min(MAX_SERVINGS, Math.max(MIN_SERVINGS, servings));
};

// Attach precomputed nutrition if we have it, else the estimate-pending placeholder.
const nutritionFor = (idMeal, category) => {
  const c = NUTRITION[String(idMeal)];
  if (!c) {
    return { calories: null, protein: null, carbs: null, fats: null, estimated: true, status: "pending" };
  }
  const servings = estimateServings(c.totalGrams, c.calories, category);
  return {
    calories: c.calories, protein: c.protein, carbs: c.carbs, fats: c.fats, sugar: c.sugar,
    estimated: true, status: "computed", basis: c.basis || "whole_recipe",
    coverage: c.coverage, lowConfidence: !!c.lowConfidence,
    servings: servings || 1,
    servingsEstimated: true,
  };
};

const toDishCard = (meal) => ({
  source: "themealdb",
  id: String(meal.idMeal),
  title: meal.strMeal || "",
  image: meal.strMealThumb || "",
});

// GET /api/themealdb/areas -> cuisines that actually have recipes, with counts.
// Served from the precomputed file (the raw a=list is ~192 mostly-empty areas).
themealdbRoutes.get("/areas", async (req, res) => {
  // Short cache: this list changes when we regenerate themealdb_areas.json, so a
  // 24h client cache would strand users on a stale list. It's served from a local
  // file, so re-fetching cheaply is fine.
  res.set("Cache-Control", "public, max-age=300");
  return res.json({ areas: AREAS_WITH_RECIPES });
});

// GET /api/themealdb/by-area/:area -> dishes for a cuisine
themealdbRoutes.get("/by-area/:area", async (req, res) => {
  const area = String(req.params.area || "").trim();
  if (!area) return res.status(400).json({ error: "area required" });
  const cacheKey = `area:${area.toLowerCase()}`;
  const cached = LIST_CACHE.get(cacheKey);
  if (cached) {
    res.set("Cache-Control", LIST_CACHE_HEADER);
    return res.json(cached);
  }
  try {
    const data = await fetchMealDb(`filter.php?a=${encodeURIComponent(area)}`);
    const dishes = ensureArray(data.meals).map(toDishCard);
    const payload = { area, count: dishes.length, dishes };
    LIST_CACHE.set(cacheKey, payload);
    res.set("Cache-Control", LIST_CACHE_HEADER);
    return res.json(payload);
  } catch (error) {
    return res.status(502).json({ error: "Failed to load dishes", detail: String(error.message || error) });
  }
});

// GET /api/themealdb/recipe/:id -> full recipe (unified model)
themealdbRoutes.get("/recipe/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: "invalid id" });
  const cacheKey = `recipe:${id}`;
  const cached = RECIPE_CACHE.get(cacheKey);
  if (cached) {
    res.set("Cache-Control", RECIPE_CACHE_HEADER);
    return res.json(cached);
  }
  try {
    const data = await fetchMealDb(`lookup.php?i=${encodeURIComponent(id)}`);
    const meal = ensureArray(data.meals)[0];
    if (!meal) return res.status(404).json({ error: "recipe not found" });
    const recipe = toUnifiedRecipe(meal);
    RECIPE_CACHE.set(cacheKey, recipe);
    res.set("Cache-Control", RECIPE_CACHE_HEADER);
    return res.json(recipe);
  } catch (error) {
    return res.status(502).json({ error: "Failed to load recipe", detail: String(error.message || error) });
  }
});

export default themealdbRoutes;
