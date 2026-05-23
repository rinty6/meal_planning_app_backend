import express from "express";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

import { db } from "../config/db.js";
import {
  calorieGoalsTable,
  favouritesTable,
  mealPlanEventsTable,
  mealPlanPreferencesTable,
  usersTable,
} from "../db/schema.js";
import { getFoodItemById, searchFoodItems, searchRecipes } from "../services/mealAPI.js";
import { getMostConsumedForUser } from "../services/mostConsumedMeals.js";
import { createTtlCache } from "../utils/ttlCache.js";

const mealPlanRoutes = express.Router();

export const ALLOWED_MEAL_PLAN_ALLERGENS = [
  "Egg",
  "Fish",
  "Gluten",
  "Lactose",
  "Milk",
  "Nuts",
  "Peanuts",
  "Sesame",
  "Shellfish",
  "Soy",
];

export const ALLOWED_MEAL_PLAN_DIETS = ["Vegan", "Vegetarian"];

const MEAL_TYPES = ["breakfast", "lunch", "dinner"];
const ALLOWED_EVENT_TYPES = new Set([
  "shown",
  "selected",
  "unselected",
  "accepted",
  "skipped",
  "loved",
  "shuffled",
]);
const NUTRIENT_KEYS = ["calories", "protein", "carbs", "fat", "fiber", "sugar", "sodium", "cholesterol"];
const DEFAULT_DAILY_CALORIES = 2000;
const RECOMMENDATION_CACHE_TTL_MS = 30 * 60 * 1000;
const recommendationCache = createTtlCache({
  ttlMs: RECOMMENDATION_CACHE_TTL_MS,
  maxEntries: 1000,
});
const recommendationInFlight = new Map();
const MEAL_PLAN_QUERY_LIMIT = 3;
const MEAL_PLAN_FOOD_SEARCH_LIMIT = 4;
const MEAL_PLAN_RECIPE_SEARCH_LIMIT = 3;
const MEAL_PLAN_FOOD_DETAIL_HYDRATION_LIMIT = 1;
// A cold FatSecret-backed all-meal build can take 2-3 seconds even with bounded
// fan-out. Warn only when it becomes user-visible again.
const MEAL_PLAN_SLOW_LOG_MS = 4000;

mealPlanRoutes.use((req, res, next) => {
  delete req.headers["if-none-match"];
  delete req.headers["if-modified-since"];
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

let mealPlanStorageReadyPromise = null;
let mealPlanStorageReadyLogged = false;

const DEFAULT_PREFERENCES = {
  allergens: [],
  diets: [],
  nutrientLimits: {},
};

const DEFAULT_QUERIES_BY_MEAL = {
  breakfast: ["Oatmeal", "Greek Yogurt", "Avocado Toast", "Breakfast Bowl", "Smoothie"],
  lunch: ["Chicken Salad", "Rice Bowl", "Sandwich", "Soup", "Wrap"],
  dinner: ["Grilled Chicken", "Salmon", "Stir Fry", "Curry", "Pasta"],
};

const ALLERGEN_KEYWORDS = {
  Egg: ["egg", "eggs", "omelet", "omelette", "scramble", "scrambled"],
  Fish: ["fish", "salmon", "tuna", "cod", "sardine", "anchovy", "mackerel"],
  Gluten: ["gluten", "wheat", "barley", "rye", "bread", "pasta", "noodle", "noodles", "flour"],
  Lactose: ["lactose", "milk", "cheese", "yogurt", "yoghurt", "cream", "butter", "whey"],
  Milk: ["milk", "cheese", "yogurt", "yoghurt", "cream", "butter", "whey"],
  Nuts: ["almond", "cashew", "walnut", "hazelnut", "pistachio", "pecan", "macadamia", "nut", "nuts"],
  Peanuts: ["peanut", "peanuts"],
  Sesame: ["sesame", "tahini"],
  Shellfish: ["shellfish", "shrimp", "prawn", "crab", "lobster", "oyster", "mussel", "scallop"],
  Soy: ["soy", "soya", "tofu", "edamame", "tempeh", "miso"],
};

const VEGAN_BLOCKLIST = [
  "beef",
  "chicken",
  "pork",
  "turkey",
  "lamb",
  "bacon",
  "ham",
  "sausage",
  "fish",
  "salmon",
  "tuna",
  "shrimp",
  "prawn",
  "crab",
  "lobster",
  "egg",
  "milk",
  "cheese",
  "yogurt",
  "cream",
  "butter",
  "honey",
];

const VEGETARIAN_BLOCKLIST = [
  "beef",
  "chicken",
  "pork",
  "turkey",
  "lamb",
  "bacon",
  "ham",
  "sausage",
  "fish",
  "salmon",
  "tuna",
  "shrimp",
  "prawn",
  "crab",
  "lobster",
  "shellfish",
];

export const ensureMealPlanStorage = async () => {
  if (!mealPlanStorageReadyPromise) {
    mealPlanStorageReadyPromise = (async () => {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "meal_plan_preferences" (
          "id" serial PRIMARY KEY NOT NULL,
          "user_id" integer NOT NULL REFERENCES "public"."user_info"("id") ON DELETE cascade ON UPDATE no action,
          "allergens" jsonb DEFAULT '[]'::jsonb NOT NULL,
          "diets" jsonb DEFAULT '[]'::jsonb NOT NULL,
          "nutrient_limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
          "created_at" timestamp DEFAULT now() NOT NULL,
          "updated_at" timestamp DEFAULT now() NOT NULL,
          CONSTRAINT "meal_plan_preferences_user_id_unique" UNIQUE("user_id")
        );
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "meal_plan_events" (
          "id" serial PRIMARY KEY NOT NULL,
          "user_id" integer NOT NULL REFERENCES "public"."user_info"("id") ON DELETE cascade ON UPDATE no action,
          "clerk_id" text,
          "event_type" text NOT NULL,
          "meal_type" text,
          "item_id" text,
          "item_title" text,
          "source" text,
          "rank" integer,
          "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
          "created_at" timestamp DEFAULT now() NOT NULL
        );
      `);

      await db.execute(sql.raw(
        'CREATE UNIQUE INDEX IF NOT EXISTS "meal_plan_preferences_user_id_idx" ON "meal_plan_preferences" USING btree ("user_id")'
      ));
      await db.execute(sql.raw(
        'CREATE INDEX IF NOT EXISTS "meal_plan_events_user_created_at_idx" ON "meal_plan_events" USING btree ("user_id","created_at")'
      ));

      await db.execute(sql`ALTER TABLE "meal_logs" ADD COLUMN IF NOT EXISTS "external_id" text;`);
      await db.execute(sql`ALTER TABLE "meal_logs" ADD COLUMN IF NOT EXISTS "source" text;`);
      await db.execute(sql`ALTER TABLE "meal_logs" ADD COLUMN IF NOT EXISTS "serving_id" text;`);
      await db.execute(sql`ALTER TABLE "meal_logs" ADD COLUMN IF NOT EXISTS "serving_description" text;`);
      await db.execute(sql`ALTER TABLE "meal_logs" ADD COLUMN IF NOT EXISTS "nutrients" jsonb DEFAULT '{}'::jsonb;`);

      if (!mealPlanStorageReadyLogged) {
        console.log("[mealPlan.js] meal-plan storage is ready");
        mealPlanStorageReadyLogged = true;
      }
    })().catch((error) => {
      mealPlanStorageReadyPromise = null;
      throw error;
    });
  }

  return mealPlanStorageReadyPromise;
};

const ensureArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeWhitespace = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const normalizeKey = (value) => normalizeWhitespace(value).toLowerCase();
const normalizeDateString = (rawDate) => {
  const dateStr = normalizeWhitespace(rawDate);
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : new Date().toISOString().slice(0, 10);
};

const parseBool = (value) => {
  const normalized = normalizeKey(value);
  return ["1", "true", "yes", "on"].includes(normalized);
};

const getUserByClerkId = async (clerkId) => {
  const users = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId)).limit(1);
  return users.length > 0 ? users[0] : null;
};

const normalizeMealType = (value) => {
  const mealType = normalizeKey(value);
  return MEAL_TYPES.includes(mealType) ? mealType : null;
};

const normalizeAllowedLabel = (value, allowedValues) => {
  const cleaned = normalizeWhitespace(value).replace(/-free$/i, "");
  const key = normalizeKey(cleaned);
  return allowedValues.find((allowed) => normalizeKey(allowed) === key) || null;
};

const normalizePreferenceList = (values, allowedValues) => {
  const output = [];
  const seen = new Set();
  for (const value of ensureArray(values)) {
    const normalized = normalizeAllowedLabel(value, allowedValues);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
};

const normalizeNutrientLimits = (value) => {
  const limits = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const output = {};

  for (const key of NUTRIENT_KEYS) {
    const raw = limits[key] || limits[key === "fat" ? "fats" : key] || {};
    if (!raw || typeof raw !== "object") continue;

    const min = raw.min === "" || raw.min === null || raw.min === undefined ? null : toNumber(raw.min, NaN);
    const max = raw.max === "" || raw.max === null || raw.max === undefined ? null : toNumber(raw.max, NaN);
    const normalized = {};
    if (Number.isFinite(min)) normalized.min = Math.max(0, min);
    if (Number.isFinite(max)) normalized.max = Math.max(0, max);
    if (normalized.min !== undefined || normalized.max !== undefined) {
      output[key] = normalized;
    }
  }

  return output;
};

const normalizePreferences = (value = {}) => ({
  allergens: normalizePreferenceList(value?.allergens, ALLOWED_MEAL_PLAN_ALLERGENS),
  diets: normalizePreferenceList(value?.diets || value?.diet, ALLOWED_MEAL_PLAN_DIETS),
  nutrientLimits: normalizeNutrientLimits(value?.nutrientLimits || value?.nutrient_limits),
});

const countActiveFilters = (preferences) =>
  ensureArray(preferences?.allergens).length +
  ensureArray(preferences?.diets).length +
  Object.keys(preferences?.nutrientLimits || {}).length;

const getSavedPreferences = async (userId) => {
  const rows = await db
    .select()
    .from(mealPlanPreferencesTable)
    .where(eq(mealPlanPreferencesTable.userId, userId))
    .limit(1);

  if (!rows[0]) return { ...DEFAULT_PREFERENCES };
  return normalizePreferences(rows[0]);
};

const getActiveGoalForDate = async (userId, dateStr) => {
  const rows = await db
    .select()
    .from(calorieGoalsTable)
    .where(and(eq(calorieGoalsTable.userId, userId), lte(calorieGoalsTable.startDate, dateStr), gte(calorieGoalsTable.endDate, dateStr)))
    .orderBy(desc(calorieGoalsTable.createdAt))
    .limit(1);

  return Math.max(1200, toNumber(rows[0]?.dailyCalories, DEFAULT_DAILY_CALORIES));
};

const buildMealTargets = (dailyTarget) => ({
  breakfast: Math.round(dailyTarget * 0.3),
  lunch: Math.round(dailyTarget * 0.35),
  dinner: Math.round(dailyTarget * 0.35),
});

const itemIdentity = (item) =>
  normalizeWhitespace(item?.fatsecret_food_id || item?.food_id || item?.recipe_id || item?.id || item?.title);

const titleKey = (value) => normalizeKey(value).replace(/[^a-z0-9]+/g, " ").trim();

const getMostConsumed = async (userId, limit = 10) => {
  return getMostConsumedForUser(userId, { limit, byMealLimit: 5 });
};

const getFavoriteTitles = async (userId) => {
  const rows = await db
    .select({ title: favouritesTable.title })
    .from(favouritesTable)
    .where(eq(favouritesTable.userId, userId))
    .limit(50);
  return rows.map((row) => normalizeWhitespace(row.title)).filter(Boolean);
};

const getEventProfile = async (userId) => {
  const rows = await db
    .select()
    .from(mealPlanEventsTable)
    .where(eq(mealPlanEventsTable.userId, userId))
    .orderBy(desc(mealPlanEventsTable.createdAt))
    .limit(300);

  const profile = {
    skippedTitles: new Set(),
    lovedTitles: new Set(),
    acceptedTitles: new Set(),
    selectedTitles: new Set(),
    skippedIds: new Set(),
  };

  for (const row of rows) {
    const title = titleKey(row.itemTitle);
    const id = normalizeKey(row.itemId);
    if (row.eventType === "skipped") {
      if (title) profile.skippedTitles.add(title);
      if (id) profile.skippedIds.add(id);
    } else if (row.eventType === "loved") {
      if (title) profile.lovedTitles.add(title);
    } else if (row.eventType === "accepted") {
      if (title) profile.acceptedTitles.add(title);
    } else if (row.eventType === "selected") {
      if (title) profile.selectedTitles.add(title);
    }
  }

  return profile;
};

const uniqueStrings = (values, limit = 8) => {
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const text = normalizeWhitespace(value);
    const key = normalizeKey(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= limit) break;
  }
  return output;
};

const hashString = (value) => {
  let hash = 0;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
};

const rotateBySeed = (values, seed) => {
  const list = ensureArray(values);
  if (list.length <= 1 || seed === undefined || seed === null || seed === "") return list;
  const offset = hashString(seed) % list.length;
  return [...list.slice(offset), ...list.slice(0, offset)];
};

const seededScoreJitter = (seed, identity) => {
  if (seed === undefined || seed === null || seed === "") return 0;
  return (hashString(`${seed}:${identity}`) % 1200) / 100;
};

const buildSearchQueries = ({ mealType, preferences, mostConsumedByMeal, favoriteTitles, forceExploration, explorationSeed }) => {
  const dietPrefix = preferences.diets[0] ? `${preferences.diets[0]} ` : "";
  const historyQueries = ensureArray(mostConsumedByMeal?.[mealType])
    .map((item) => item.title)
    .slice(0, 2);
  const favoriteQueries = ensureArray(favoriteTitles).slice(0, 2);
  const defaultQueries = DEFAULT_QUERIES_BY_MEAL[mealType] || [];
  const rotatedDefaults = forceExploration
    ? rotateBySeed(defaultQueries, explorationSeed || Date.now())
    : defaultQueries;
  const rotatedHistoryQueries = forceExploration ? rotateBySeed(historyQueries, explorationSeed) : historyQueries;
  const rotatedFavoriteQueries = forceExploration ? rotateBySeed(favoriteQueries, explorationSeed) : favoriteQueries;

  return uniqueStrings(
    [
      `${dietPrefix}${mealType}`,
      ...rotatedHistoryQueries.map((title) => `${dietPrefix}${title}`),
      ...rotatedFavoriteQueries.map((title) => `${dietPrefix}${title}`),
      ...rotatedDefaults.map((query) => `${dietPrefix}${query}`),
    ],
    MEAL_PLAN_QUERY_LIMIT
  );
};

const extractImageFromFoodSearchHit = (item) => item?.image || item?.food_image?.image_url || "";

const normalizeFoodCandidate = (food, mealType, query, rankBase = 0) => {
  if (!food) return null;
  const id = normalizeWhitespace(food.food_id || food.id);
  const title = normalizeWhitespace(food.title || food.food_name);
  if (!id || !title) return null;

  return {
    id,
    food_id: id,
    fatsecret_food_id: id,
    recipe_id: "",
    source: "fatsecret_food",
    type: "food",
    mealType,
    title,
    food_name: title,
    description: food.description || "",
    calories: Math.round(toNumber(food.calories)),
    protein: Math.round(toNumber(food.protein) * 10) / 10,
    carbs: Math.round(toNumber(food.carbs) * 10) / 10,
    fats: Math.round(toNumber(food.fats) * 10) / 10,
    fiber: toNumber(food.fiber),
    sugar: toNumber(food.sugar),
    sodium: toNumber(food.sodium),
    cholesterol: toNumber(food.cholesterol),
    grams: Math.round(toNumber(food.metric_serving_amount, 100) || 100),
    image: food.image || extractImageFromFoodSearchHit(food) || "",
    brand_name: food.brand_name || null,
    food_type: food.food_type || "Generic",
    food_url: food.food_url || null,
    serving_id: food.serving_id || null,
    serving_description: food.serving_description || "1 serving",
    metric_serving_amount: toNumber(food.metric_serving_amount, 100) || 100,
    metric_serving_unit: food.metric_serving_unit || null,
    measurement_description: food.measurement_description || null,
    allergens: ensureArray(food.allergens),
    preferences: ensureArray(food.preferences),
    food_sub_categories: ensureArray(food.food_sub_categories),
    per100: food.per100 || {},
    retriever_query: query,
    rank_base: rankBase,
  };
};

const normalizeRecipeCandidate = (recipe, mealType, query, rankBase = 0) => {
  const recipeId = normalizeWhitespace(recipe?.recipe_id || recipe?.id);
  const title = normalizeWhitespace(recipe?.title || recipe?.recipe_name);
  if (!recipeId || !title) return null;

  return {
    id: `recipe-${recipeId}`,
    food_id: "",
    fatsecret_food_id: "",
    recipe_id: recipeId,
    source: "fatsecret_recipe",
    type: "recipe",
    mealType,
    title,
    food_name: title,
    description: recipe.description || "",
    calories: Math.round(toNumber(recipe.calories)),
    protein: Math.round(toNumber(recipe.protein) * 10) / 10,
    carbs: Math.round(toNumber(recipe.carbs) * 10) / 10,
    fats: Math.round(toNumber(recipe.fats) * 10) / 10,
    grams: 1,
    image: recipe.image || "",
    time: recipe.time || "15 min",
    serving_description: "1 serving",
    retriever_query: query,
    rank_base: rankBase,
  };
};

const textForCandidate = (candidate) =>
  normalizeKey([
    candidate?.title,
    candidate?.food_name,
    candidate?.description,
    candidate?.brand_name,
    candidate?.food_type,
    ...ensureArray(candidate?.food_sub_categories),
  ].filter(Boolean).join(" "));

const hasBlockedKeyword = (text, keywords) =>
  keywords.some((keyword) => new RegExp(`(^|[^a-z])${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(text));

const hasApiAllergen = (candidate, allergen) => {
  const allergenKey = normalizeKey(allergen);
  return ensureArray(candidate?.allergens).some((entry) => {
    const name = normalizeKey(entry?.name || entry?.allergen_name || entry);
    const value = normalizeKey(entry?.value ?? entry?.contains ?? "");
    if (!name.includes(allergenKey)) return false;
    return !["0", "false", "no", "none"].includes(value);
  });
};

const passesAllergenFilters = (candidate, allergens) => {
  const text = textForCandidate(candidate);
  return ensureArray(allergens).every((allergen) => {
    const keywords = ALLERGEN_KEYWORDS[allergen] || [];
    if (hasApiAllergen(candidate, allergen)) return false;
    return !hasBlockedKeyword(text, keywords);
  });
};

const candidatePreferenceNames = (candidate) =>
  ensureArray(candidate?.preferences)
    .flatMap((entry) => [entry?.name, entry?.value, entry?.preference, entry])
    .map((entry) => normalizeKey(entry))
    .filter(Boolean);

const passesDietFilters = (candidate, diets) => {
  const normalizedDiets = normalizePreferenceList(diets, ALLOWED_MEAL_PLAN_DIETS);
  if (normalizedDiets.length === 0) return true;

  const candidatePrefs = candidatePreferenceNames(candidate);
  const text = textForCandidate(candidate);

  return normalizedDiets.every((diet) => {
    const dietKey = normalizeKey(diet);
    if (candidatePrefs.length > 0) {
      if (dietKey === "vegetarian") {
        return candidatePrefs.some((pref) => pref.includes("vegetarian") || pref.includes("vegan"));
      }
      return candidatePrefs.some((pref) => pref.includes("vegan"));
    }

    if (dietKey === "vegan") return !hasBlockedKeyword(text, VEGAN_BLOCKLIST);
    if (dietKey === "vegetarian") return !hasBlockedKeyword(text, VEGETARIAN_BLOCKLIST);
    return true;
  });
};

const getNutrientValue = (candidate, key) => {
  if (key === "fat") return toNumber(candidate?.per100?.fats, NaN) || toNumber(candidate?.fats, 0);
  if (key === "carbs") return toNumber(candidate?.per100?.carbs, NaN) || toNumber(candidate?.carbs, 0);
  if (key === "protein") return toNumber(candidate?.per100?.protein, NaN) || toNumber(candidate?.protein, 0);
  if (key === "calories") return toNumber(candidate?.per100?.calories, NaN) || toNumber(candidate?.calories, 0);
  return toNumber(candidate?.[key], 0);
};

const passesNutrientFilters = (candidate, nutrientLimits) => {
  for (const [key, limit] of Object.entries(nutrientLimits || {})) {
    const value = getNutrientValue(candidate, key);
    if (limit?.min !== undefined && value < Number(limit.min)) return false;
    if (limit?.max !== undefined && value > Number(limit.max)) return false;
  }
  return true;
};

const passesPreferenceFilters = (candidate, preferences) =>
  passesAllergenFilters(candidate, preferences.allergens) &&
  passesDietFilters(candidate, preferences.diets) &&
  passesNutrientFilters(candidate, preferences.nutrientLimits);

const scoreCandidate = ({ candidate, mealTarget, mostConsumedByMeal, favoriteTitles, eventProfile, forceExploration, explorationSeed }) => {
  const calories = toNumber(candidate.calories, 0);
  const calorieDiff = mealTarget > 0 && calories > 0 ? Math.abs(calories - mealTarget) / mealTarget : 0.35;
  const key = titleKey(candidate.title);
  const id = normalizeKey(itemIdentity(candidate));
  const favoriteKeys = new Set(ensureArray(favoriteTitles).map(titleKey));
  const historyKeys = new Set(ensureArray(mostConsumedByMeal?.[candidate.mealType]).map((item) => titleKey(item.title)));

  let score = 100 - Math.min(45, calorieDiff * 60);
  if (candidate.image) score += 12;
  if (candidate.source === "fatsecret_recipe") score += 18;
  if (normalizeKey(candidate.food_type) === "brand") score -= 22;
  if (favoriteKeys.has(key)) score += 18;
  if (historyKeys.has(key)) score += 10;
  if (eventProfile.lovedTitles.has(key)) score += 16;
  if (eventProfile.acceptedTitles.has(key)) score += 12;
  if (eventProfile.selectedTitles.has(key)) score += 6;
  if (eventProfile.skippedTitles.has(key) || eventProfile.skippedIds.has(id)) score -= 80;
  score -= toNumber(candidate.rank_base, 0) * 0.4;
  if (forceExploration) score += seededScoreJitter(explorationSeed, `${id}:${key}`);
  return Math.round(score * 100) / 100;
};

const fetchFoodCandidatesForQuery = async ({ query, mealType, mealTarget, rankBase }) => {
  const hits = await searchFoodItems(
    { query, maxResults: MEAL_PLAN_FOOD_SEARCH_LIMIT, mealType, foodType: "generic" },
    MEAL_PLAN_FOOD_SEARCH_LIMIT
  ).catch(() => []);
  const uniqueHits = [];
  const seen = new Set();
  for (const hit of hits) {
    const id = normalizeWhitespace(hit?.id || hit?.food_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueHits.push(hit);
    if (uniqueHits.length >= MEAL_PLAN_FOOD_SEARCH_LIMIT) break;
  }

  const hydratedEntries = await Promise.all(
    uniqueHits.slice(0, MEAL_PLAN_FOOD_DETAIL_HYDRATION_LIMIT).map(async (hit) => {
      const id = normalizeWhitespace(hit?.id || hit?.food_id);
      const detail = await getFoodItemById(id, { expectedCalories: mealTarget }).catch(() => null);
      return [id, detail];
    })
  );
  const hydratedById = new Map(hydratedEntries.filter(([, detail]) => detail));

  return uniqueHits
    .map((hit, index) => {
      const id = normalizeWhitespace(hit?.id || hit?.food_id);
      return normalizeFoodCandidate(hydratedById.get(id) || hit, mealType, query, rankBase + index);
    })
    .filter(Boolean);
};

const fetchRecipeCandidatesForQuery = async ({ query, mealType, rankBase }) => {
  const recipes = await searchRecipes(
    { query, maxResults: MEAL_PLAN_RECIPE_SEARCH_LIMIT, mealType },
    MEAL_PLAN_RECIPE_SEARCH_LIMIT
  ).catch(() => []);
  return recipes
    .map((recipe, index) => normalizeRecipeCandidate(recipe, mealType, query, rankBase + index))
    .filter(Boolean);
};

const buildRecommendationsForMeal = async ({
  mealType,
  preferences,
  mealTarget,
  mostConsumedByMeal,
  favoriteTitles,
  eventProfile,
  forceExploration,
  explorationSeed,
}) => {
  const queries = buildSearchQueries({
    mealType,
    preferences,
    mostConsumedByMeal,
    favoriteTitles,
    forceExploration,
    explorationSeed,
  });

  const batches = await Promise.all(
    queries.map((query, queryIndex) =>
      Promise.all([
        fetchFoodCandidatesForQuery({
          query,
          mealType,
          mealTarget,
          rankBase: queryIndex * 10,
        }),
        fetchRecipeCandidatesForQuery({
          query,
          mealType,
          rankBase: queryIndex * 10 + 5,
        }),
      ])
    )
  );

  const candidates = batches.flat(2);
  const dedupedByKey = new Map();
  for (const candidate of candidates) {
    const key = titleKey(candidate.title) || itemIdentity(candidate);
    if (!key) continue;
    if (!passesPreferenceFilters(candidate, preferences)) continue;
    const score = scoreCandidate({
      candidate,
      mealTarget,
      mostConsumedByMeal,
      favoriteTitles,
      eventProfile,
      forceExploration,
      explorationSeed,
    });
    const rankedCandidate = {
      ...candidate,
      score,
      explanation: "Recommended from FatSecret foods and recipes based on your filters and eating history.",
      behavioral_insight: "Recommended from FatSecret foods and recipes based on your filters and eating history.",
      ml_tag: "FATSECRET_V3",
      calorie_target: mealTarget,
    };
    const existing = dedupedByKey.get(key);
    if (!existing || rankedCandidate.score > existing.score) {
      dedupedByKey.set(key, rankedCandidate);
    }
  }

  const deduped = Array.from(dedupedByKey.values());
  const imageReady = deduped.filter((item) => item.image);
  const rankedPool = imageReady.length >= 5 ? imageReady : deduped;

  return rankedPool
    .sort((left, right) => {
      if (Boolean(left.image) !== Boolean(right.image)) {
        return right.image ? 1 : -1;
      }
      return right.score - left.score;
    })
    .slice(0, 8)
    .map((item, index) => ({ ...item, rank: index + 1 }));
};

const serializePreferencesResponse = (preferences) => ({
  preferences,
  allowedAllergens: ALLOWED_MEAL_PLAN_ALLERGENS,
  allowedDiets: ALLOWED_MEAL_PLAN_DIETS,
  allowedNutrients: NUTRIENT_KEYS,
  activeFilterCount: countActiveFilters(preferences),
});

const getEventItemsFromBody = (body) => {
  if (Array.isArray(body?.items)) return body.items;
  if (body?.item && typeof body.item === "object") return [body.item];
  return [{
    id: body?.itemId || body?.id || null,
    title: body?.itemTitle || body?.title || null,
    source: body?.source || null,
    rank: body?.rank ?? null,
  }];
};

const recordEvents = async ({ user, clerkId, eventType, mealType, items, payload = {} }) => {
  const rows = ensureArray(items)
    .map((item) => ({
      userId: user.userId,
      clerkId: clerkId || user.clerkId,
      eventType,
      mealType: normalizeMealType(mealType || item?.mealType) || null,
      itemId: normalizeWhitespace(itemIdentity(item)) || null,
      itemTitle: normalizeWhitespace(item?.title || item?.food_name || item?.itemTitle) || null,
      source: normalizeWhitespace(item?.source) || null,
      rank: Number.isFinite(Number(item?.rank)) ? Number(item.rank) : null,
      payload: {
        ...payload,
        item,
      },
    }))
    .filter((row) => row.itemId || row.itemTitle || eventType === "shuffled");

  if (rows.length === 0) return 0;
  await ensureMealPlanStorage();
  await db.insert(mealPlanEventsTable).values(rows);
  return rows.length;
};

const recordShownEvents = ({ user, clerkId, recommendationsByMeal, preferences }) => {
  const rows = [];
  for (const mealType of MEAL_TYPES) {
    for (const item of ensureArray(recommendationsByMeal?.[mealType])) {
      rows.push({
        ...item,
        mealType,
      });
    }
  }
  if (rows.length === 0) return;

  void recordEvents({
    user,
    clerkId,
    eventType: "shown",
    mealType: null,
    items: rows,
    payload: {
      activeFilterCount: countActiveFilters(preferences),
      generatedAt: new Date().toISOString(),
    },
  }).catch((error) => {
    console.warn("[mealPlan.js] failed to record shown events", error?.message || error);
  });
};

mealPlanRoutes.get("/preferences/:clerkId", async (req, res) => {
  try {
    await ensureMealPlanStorage();
    const user = await getUserByClerkId(req.params.clerkId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const preferences = await getSavedPreferences(user.userId);
    return res.status(200).json(serializePreferencesResponse(preferences));
  } catch (error) {
    console.error("Meal plan preferences fetch error:", error);
    return res.status(500).json({ error: "Failed to fetch meal plan preferences" });
  }
});

mealPlanRoutes.put("/preferences/:clerkId", async (req, res) => {
  try {
    await ensureMealPlanStorage();
    const user = await getUserByClerkId(req.params.clerkId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const preferences = normalizePreferences(req.body?.preferences || req.body || {});
    await db
      .insert(mealPlanPreferencesTable)
      .values({
        userId: user.userId,
        allergens: preferences.allergens,
        diets: preferences.diets,
        nutrientLimits: preferences.nutrientLimits,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: mealPlanPreferencesTable.userId,
        set: {
          allergens: preferences.allergens,
          diets: preferences.diets,
          nutrientLimits: preferences.nutrientLimits,
          updatedAt: new Date(),
        },
      });

    return res.status(200).json(serializePreferencesResponse(preferences));
  } catch (error) {
    console.error("Meal plan preferences save error:", error);
    return res.status(500).json({ error: "Failed to save meal plan preferences" });
  }
});

mealPlanRoutes.get("/recommendations/:clerkId", async (req, res) => {
  try {
    const requestStartedAt = Date.now();
    await ensureMealPlanStorage();
    const { clerkId } = req.params;
    const user = await getUserByClerkId(clerkId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const selectedMealType = normalizeMealType(req.query.mealType);
    const forceExploration = parseBool(req.query.force_exploration) || parseBool(req.query.forceExploration);
    const explorationSeed = normalizeWhitespace(req.query.exploration_seed || req.query.explorationSeed);
    const dateStr = normalizeDateString(req.query.date);
    const preferences = normalizePreferences(req.query.preferences ? JSON.parse(String(req.query.preferences)) : await getSavedPreferences(user.userId));
    const cacheKey = JSON.stringify({
      userId: user.userId,
      mealType: selectedMealType || "all",
      dateStr,
      preferences,
    });

    if (!forceExploration) {
      const cached = recommendationCache.get(cacheKey);
      if (cached) return res.status(200).json(cached);

      const inFlight = recommendationInFlight.get(cacheKey);
      if (inFlight) {
        const payload = await inFlight;
        return res.status(200).json(payload);
      }
    }

    const buildPromise = (async () => {
      const [dailyTarget, mostConsumed, favoriteTitles, eventProfile] = await Promise.all([
        getActiveGoalForDate(user.userId, dateStr),
        getMostConsumed(user.userId, 10),
        getFavoriteTitles(user.userId),
        getEventProfile(user.userId),
      ]);

      const mealTargets = buildMealTargets(dailyTarget);
      const mealTypesToBuild = selectedMealType ? [selectedMealType] : MEAL_TYPES;
      const recommendationsByMeal = { breakfast: [], lunch: [], dinner: [] };

      await Promise.all(
        mealTypesToBuild.map(async (mealType) => {
          recommendationsByMeal[mealType] = await buildRecommendationsForMeal({
            mealType,
            preferences,
            mealTarget: mealTargets[mealType],
            mostConsumedByMeal: mostConsumed.byMeal,
            favoriteTitles,
            eventProfile,
            forceExploration,
            explorationSeed,
          });
        })
      );

      const payload = {
        source: "fatsecret_v3",
        recommendationsByMeal,
        recommendedByMeal: recommendationsByMeal,
        recommended: selectedMealType ? recommendationsByMeal[selectedMealType] : undefined,
        meal_calorie_targets: mealTargets,
        meal_calorie_target: selectedMealType ? mealTargets[selectedMealType] : undefined,
        daily_calorie_target: dailyTarget,
        most_consumed_items: mostConsumed.all,
        most_consumed_by_meal: mostConsumed.byMeal,
        preferences,
        active_filter_count: countActiveFilters(preferences),
        allowed_allergens: ALLOWED_MEAL_PLAN_ALLERGENS,
        allowed_diets: ALLOWED_MEAL_PLAN_DIETS,
        allowed_nutrients: NUTRIENT_KEYS,
        used_safety_fallback: false,
        force_exploration_used: forceExploration,
        exploration_seed: explorationSeed || null,
      };

      if (!forceExploration) {
        recommendationCache.set(cacheKey, payload);
      }

      const durationMs = Date.now() - requestStartedAt;
      if (durationMs > MEAL_PLAN_SLOW_LOG_MS) {
        const totalRecommendations = Object.values(recommendationsByMeal)
          .reduce((sum, items) => sum + ensureArray(items).length, 0);
        console.warn("[mealPlan.js] slow recommendation build", {
          durationMs,
          clerkId,
          mealTypesBuilt: mealTypesToBuild,
          queryLimit: MEAL_PLAN_QUERY_LIMIT,
          foodSearchLimit: MEAL_PLAN_FOOD_SEARCH_LIMIT,
          foodDetailHydrationLimit: MEAL_PLAN_FOOD_DETAIL_HYDRATION_LIMIT,
          recipeSearchLimit: MEAL_PLAN_RECIPE_SEARCH_LIMIT,
          totalRecommendations,
        });
      }

      return payload;
    })();

    if (!forceExploration) {
      recommendationInFlight.set(cacheKey, buildPromise);
    }

    const payload = await buildPromise.finally(() => {
      if (!forceExploration) {
        recommendationInFlight.delete(cacheKey);
      }
    });

    recordShownEvents({ user, clerkId, recommendationsByMeal: payload.recommendationsByMeal, preferences });

    return res.status(200).json(payload);
  } catch (error) {
    console.error("Meal plan recommendations error:", error);
    return res.status(500).json({ error: "Failed to build meal plan recommendations" });
  }
});

mealPlanRoutes.post("/events", async (req, res) => {
  try {
    await ensureMealPlanStorage();
    const clerkId = normalizeWhitespace(req.body?.clerkId);
    const eventType = normalizeKey(req.body?.eventType || req.body?.type);
    if (!clerkId || !ALLOWED_EVENT_TYPES.has(eventType)) {
      return res.status(400).json({ error: "Missing or invalid event payload." });
    }

    const user = await getUserByClerkId(clerkId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const count = await recordEvents({
      user,
      clerkId,
      eventType,
      mealType: req.body?.mealType,
      items: getEventItemsFromBody(req.body),
      payload: {
        preferences: normalizePreferences(req.body?.preferences || {}),
        context: req.body?.context || null,
      },
    });

    return res.status(200).json({ success: true, recorded: count });
  } catch (error) {
    console.error("Meal plan event error:", error);
    return res.status(500).json({ error: "Failed to record meal plan event" });
  }
});

export default mealPlanRoutes;
