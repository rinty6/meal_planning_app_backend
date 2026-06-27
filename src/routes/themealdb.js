import express from "express";

import { ENV } from "../config/env.js";
import { createTtlCache } from "../utils/ttlCache.js";

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
    if (name) out.push({ name, measure });
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
  // Phase 2 (USDA) fills these in; flagged so the UI shows an "estimate pending" state.
  nutrition: { calories: null, protein: null, carbs: null, fats: null, estimated: true, status: "pending" },
});

const toDishCard = (meal) => ({
  source: "themealdb",
  id: String(meal.idMeal),
  title: meal.strMeal || "",
  image: meal.strMealThumb || "",
});

// GET /api/themealdb/areas -> list of cuisines/countries
themealdbRoutes.get("/areas", async (req, res) => {
  const cacheKey = "areas";
  const cached = LIST_CACHE.get(cacheKey);
  if (cached) {
    res.set("Cache-Control", LIST_CACHE_HEADER);
    return res.json(cached);
  }
  try {
    const data = await fetchMealDb("list.php?a=list");
    const areas = [...new Set(
      ensureArray(data.meals)
        .map((m) => String(m.strArea || "").trim())
        .filter((a) => a && a !== "Unknown")
    )].sort();
    const payload = { areas };
    LIST_CACHE.set(cacheKey, payload);
    res.set("Cache-Control", LIST_CACHE_HEADER);
    return res.json(payload);
  } catch (error) {
    return res.status(502).json({ error: "Failed to load cuisines", detail: String(error.message || error) });
  }
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
