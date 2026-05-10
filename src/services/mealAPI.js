import fetch from "node-fetch";
import "dotenv/config";
import pkg from "base-64";
export { scaleComboToTarget, scaleToTarget } from "./mealAPIScaling.js";
import {
  choosePrimaryServing,
  normalizePer100,
  parseAllergens,
  parseDescriptionMacros,
  parsePreferences,
  parseSubCategories,
} from "./mealAPIParsers.js";

const { encode } = pkg;

const CLIENT_ID = process.env.FATSECRET_CLIENT_ID;
const CLIENT_SECRET = process.env.FATSECRET_CLIENT_SECRET;
const OAUTH_URL = "https://goodhealthmate-fs.fly.dev/connect/token";
const API_URL = "https://goodhealthmate-fs.fly.dev/rest/server.api";

const TOKEN_REFRESH_BUFFER_MS = 30 * 1000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const servingRichnessFields = [
  "saturated_fat",
  "trans_fat",
  "polyunsaturated_fat",
  "monounsaturated_fat",
  "cholesterol",
  "sodium",
  "fiber",
  "sugar",
  "added_sugars",
  "vitamin_d",
  "calcium",
  "iron",
  "potassium",
  "vitamin_a",
  "vitamin_c",
];

let accessToken = null;
let tokenExpiresAt = 0;

const apiCache = new Map();

const makeCacheKey = (prefix, values) => {
  const normalized = values.map((value) => String(value ?? "").trim().toLowerCase()).join("|");
  return `${prefix}:${normalized}`;
};

const getCached = (key) => {
  const cached = apiCache.get(key);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    apiCache.delete(key);
    return null;
  }

  return cached.value;
};

const setCached = (key, value) => {
  apiCache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return value;
};

const ensureArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
};

const normalizeWord = (value) => String(value ?? "").trim().toLowerCase();
// Reject non-FatSecret ids before they are proxied upstream.
const isFatSecretNumericId = (value) => /^\d+$/.test(String(value ?? "").trim());

const uniqueStrings = (values) => {
  const deduped = [];
  const seen = new Set();

  for (const value of values) {
    const normalized = normalizeWord(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(String(value).trim());
  }

  return deduped;
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

class FatSecretApiError extends Error {
  constructor(message, { status = 502, code = null, details = null } = {}) {
    super(message);
    this.name = "FatSecretApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const serializeFatSecretError = (error) => ({
  error: error?.message || "FatSecret request failed.",
  code: error?.code ?? null,
  details: error?.details ?? null,
});

const coerceFatSecretError = (error, fallbackMessage = "FatSecret request failed.") =>
  error instanceof FatSecretApiError
    ? error
    : new FatSecretApiError(fallbackMessage, {
        details: error?.message || String(error || ""),
      });

const pickBestServing = (servingArray = [], expectedCalories = 0) => {
  if (!servingArray.length) return {};
  let bestServing = servingArray[0] || {};
  let bestScore = -1;

  for (const serving of servingArray) {
    if (!serving) continue;
    const calories = toNumber(serving?.calories, 0);
    const metricAmount = toNumber(serving?.metric_serving_amount, 0);
    const hasMetric = metricAmount > 0 ? 1 : 0;
    const richness = servingRichnessFields.reduce(
      (sum, field) => sum + (toNumber(serving?.[field], 0) > 0 ? 1 : 0),
      0
    );
    const calorieDistance =
      expectedCalories > 0 && calories > 0 ? Math.abs(calories - expectedCalories) / expectedCalories : 0.5;
    const calorieMatchScore = Math.max(0, 1 - Math.min(1, calorieDistance));
    const score = richness * 2 + hasMetric + calorieMatchScore * 1.5;
    if (score > bestScore) {
      bestScore = score;
      bestServing = serving;
    }
  }

  return bestServing || {};
};

const getAccessToken = async (forceRefresh = false) => {
  if (!CLIENT_ID || !CLIENT_SECRET) return null;

  const stillValid = accessToken && Date.now() < tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS;
  if (!forceRefresh && stillValid) {
    return accessToken;
  }

  try {
    const credentials = encode(`${CLIENT_ID}:${CLIENT_SECRET}`);
    const response = await fetch(OAUTH_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=premier",
    });

    const data = await response.json();
    if (!response.ok || !data.access_token) {
      accessToken = null;
      tokenExpiresAt = 0;
      return null;
    }

    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + ((Number(data.expires_in) || 3600) * 1000);
    return accessToken;
  } catch (error) {
    console.error("Auth Error:", error);
    accessToken = null;
    tokenExpiresAt = 0;
    return null;
  }
};

const requestFatSecret = async (params, retryOnAuth = true) => {
  const token = await getAccessToken();
  if (!token) {
    throw new FatSecretApiError("FatSecret authentication failed.", {
      status: 502,
      code: "auth_failed",
    });
  }

  const response = await fetch(`${API_URL}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401 && retryOnAuth) {
    await getAccessToken(true);
    return requestFatSecret(params, false);
  }

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    throw new FatSecretApiError("FatSecret returned a non-JSON response.", {
      status: 502,
      code: "non_json_response",
      details: error?.message || null,
    });
  }

  if (!response.ok) {
    throw new FatSecretApiError("FatSecret request failed.", {
      status: response.status || 502,
      code: data?.error?.code ?? `http_${response.status}`,
      details: data?.error?.message || data?.message || data || null,
    });
  }

  if (data?.error) {
    throw new FatSecretApiError(data?.error?.message || "FatSecret API error.", {
      status: 502,
      code: data?.error?.code ?? null,
      details: data?.error || null,
    });
  }

  return data;
};

export const buildRetrieverQueries = ({ query, retrieverKeywords = [], goal = "maintain", mealType = "lunch" } = {}) => {
  const goalHints = {
    lose_weight: ["Low Calorie", "Lean Protein"],
    gain_muscle: ["High Protein", "Complex Carbs"],
    maintain: ["Balanced Meal", "Mediterranean"],
  };

  const mealHints = {
    breakfast: ["Healthy Breakfast", "Quick Breakfast"],
    lunch: ["Balanced Lunch", "Protein Lunch"],
    dinner: ["Light Dinner", "Mediterranean Dinner"],
  };

  const expanded = [
    query,
    ...ensureArray(retrieverKeywords),
    ...(goalHints[normalizeWord(goal)] || goalHints.maintain),
    ...(mealHints[normalizeWord(mealType)] || mealHints.lunch),
  ];

  return uniqueStrings(expanded).slice(0, 8);
};

const normalizeSearchInput = (queryOrOptions, maxResults, defaultMax) => {
  if (typeof queryOrOptions === "object" && queryOrOptions !== null) {
    const retrieverKeywords = ensureArray(queryOrOptions.retrieverKeywords);
    return {
      query: String(queryOrOptions.query || "").trim(),
      retrieverKeywords,
      goal: queryOrOptions.goal || "maintain",
      mealType: queryOrOptions.mealType || "lunch",
      maxResults: Number.parseInt(queryOrOptions.maxResults, 10) || maxResults || defaultMax,
      expandQueries: queryOrOptions.expandQueries === true || retrieverKeywords.length > 0,
    };
  }

  return {
    query: String(queryOrOptions || "").trim(),
    retrieverKeywords: [],
    goal: "maintain",
    mealType: "lunch",
    maxResults: Number.parseInt(maxResults, 10) || defaultMax,
    expandQueries: false,
  };
};

export const searchRecipes = async (queryOrOptions, maxResults = 1, routeOptions = {}) => {
  const { throwOnError = false, expandQueries } = routeOptions;
  const input = normalizeSearchInput(queryOrOptions, maxResults, 1);
  const shouldExpandQueries = expandQueries ?? input.expandQueries;
  const queries = shouldExpandQueries ? buildRetrieverQueries(input) : uniqueStrings([input.query]);
  if (queries.length === 0) return [];

  const mappedResults = await Promise.all(
    queries.map(async (query) => {
      const cacheKey = makeCacheKey("recipes.search", [query, input.maxResults]);
      const cached = getCached(cacheKey);
      if (cached) return cached;

      try {
        const params = new URLSearchParams({
          method: "recipes.search",
          search_expression: query,
          format: "json",
          max_results: String(input.maxResults),
          include_food_images: "true",
        });

        const data = await requestFatSecret(params);
        if (!data) return [];

        const recipes = ensureArray(data.recipes?.recipe);
        const mapped = recipes.map((item) => ({
          id: String(item.recipe_id),
          title: item.recipe_name,
          calories: Number.parseInt(item.recipe_nutrition?.calories, 10) || 0,
          protein: Number.parseFloat(item.recipe_nutrition?.protein) || 0,
          carbs: Number.parseFloat(item.recipe_nutrition?.carbohydrate) || 0,
          fats: Number.parseFloat(item.recipe_nutrition?.fat) || 0,
          image: item.recipe_image,
          time: item.preparation_time_min ? `${item.preparation_time_min} min` : "15 min",
          type: "recipe",
          retriever_query: query,
        }));

        return setCached(cacheKey, mapped);
      } catch (error) {
        console.error("Backend Search Recipe Error:", error);
        if (throwOnError) throw coerceFatSecretError(error, "Recipe search failed.");
        return [];
      }
    })
  );

  const deduped = [];
  const seen = new Set();
  for (const list of mappedResults) {
    for (const item of list) {
      const key = `${item.id}:${normalizeWord(item.title)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
  }

  return deduped.slice(0, input.maxResults);
};

export const searchFoodItems = async (queryOrOptions, maxResults = 3, routeOptions = {}) => {
  const { throwOnError = false, expandQueries } = routeOptions;
  const input = normalizeSearchInput(queryOrOptions, maxResults, 3);
  const shouldExpandQueries = expandQueries ?? input.expandQueries;
  const queries = shouldExpandQueries ? buildRetrieverQueries(input) : uniqueStrings([input.query]);
  if (queries.length === 0) return [];

  const mappedResults = await Promise.all(
    queries.map(async (query) => {
      const cacheKey = makeCacheKey("foods.search", [query, input.maxResults]);
      const cached = getCached(cacheKey);
      if (cached) return cached;

      try {
        const params = new URLSearchParams({
          method: "foods.search",
          search_expression: query,
          format: "json",
          max_results: String(input.maxResults),
          include_food_images: "true",
        });

        const data = await requestFatSecret(params);
        if (!data) return [];

        const foods = ensureArray(data.foods?.food);
        const mapped = foods.map((item) => ({
          id: String(item.food_id),
          title: item.food_name,
          description: item.food_description || "",
          food_type: item.food_type || "Generic",
          food_url: item.food_url || null,
          brand_name: item.brand_name || null,
          image: item.food_image?.image_url || (typeof item.food_image === "string" ? item.food_image : null),
          type: "food",
          retriever_query: query,
        }));

        return setCached(cacheKey, mapped);
      } catch (error) {
        console.error("searchFoodItems Error:", error);
        if (throwOnError) throw coerceFatSecretError(error, "Food search failed.");
        return [];
      }
    })
  );

  const deduped = [];
  const seen = new Set();
  for (const list of mappedResults) {
    for (const item of list) {
      const key = `${item.id}:${normalizeWord(item.title)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
  }

  return deduped.slice(0, input.maxResults);
};

export const getFoodItemById = async (foodId, options = {}) => {
  const { expectedCalories = 0, throwOnError = false } = options;
  const normalizedFoodId = String(foodId || "").trim();
  if (!normalizedFoodId) return null;
  // Stop invalid app-level ids before making a FatSecret API request.
  if (!isFatSecretNumericId(normalizedFoodId)) {
    const invalidIdError = new FatSecretApiError("Invalid FatSecret food_id.", {
      status: 400,
      code: "invalid_food_id",
      details: { foodId: normalizedFoodId },
    });
    if (throwOnError) throw invalidIdError;
    return null;
  }

  const cacheKey = makeCacheKey("food.get.v5", [normalizedFoodId, expectedCalories]);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      method: "food.get.v5",
      food_id: normalizedFoodId,
      format: "json",
      include_food_images: "true",
    });

    const data = await requestFatSecret(params);
    const food = data?.food;
    if (!food) return null;

    const servings = ensureArray(food?.servings?.serving);
    const serving = pickBestServing(servings, toNumber(expectedCalories, 0)) || choosePrimaryServing(food);
    const per100 = normalizePer100(serving);

    let imageUrl = null;
    const imgs = food.food_images?.food_image;
    if (imgs) {
      const imgArr = Array.isArray(imgs) ? imgs : [imgs];
      imageUrl = imgArr[0]?.image_url || null;
    }

    const mapped = {
      id: String(food.food_id),
      food_id: String(food.food_id),
      title: food.food_name,
      calories: Number.parseFloat(serving?.calories) || 0,
      protein: Number.parseFloat(serving?.protein) || 0,
      carbs: Number.parseFloat(serving?.carbohydrate) || 0,
      fats: Number.parseFloat(serving?.fat) || 0,
      saturated_fat: Number.parseFloat(serving?.saturated_fat) || 0,
      trans_fat: Number.parseFloat(serving?.trans_fat) || 0,
      polyunsaturated_fat: Number.parseFloat(serving?.polyunsaturated_fat) || 0,
      monounsaturated_fat: Number.parseFloat(serving?.monounsaturated_fat) || 0,
      cholesterol: Number.parseFloat(serving?.cholesterol) || 0,
      sodium: Number.parseFloat(serving?.sodium) || 0,
      fiber: Number.parseFloat(serving?.fiber) || 0,
      sugar: Number.parseFloat(serving?.sugar) || 0,
      added_sugars: Number.parseFloat(serving?.added_sugars) || 0,
      vitamin_d: Number.parseFloat(serving?.vitamin_d) || 0,
      calcium: Number.parseFloat(serving?.calcium) || 0,
      iron: Number.parseFloat(serving?.iron) || 0,
      potassium: Number.parseFloat(serving?.potassium) || 0,
      vitamin_a: Number.parseFloat(serving?.vitamin_a) || 0,
      vitamin_c: Number.parseFloat(serving?.vitamin_c) || 0,
      serving_id: serving?.serving_id || null,
      serving_description: serving?.serving_description || "100g",
      metric_serving_amount: Number.parseFloat(serving?.metric_serving_amount) || 100,
      metric_serving_unit: serving?.metric_serving_unit || null,
      number_of_units: Number.parseFloat(serving?.number_of_units) || 1,
      measurement_description: serving?.measurement_description || null,
      food_type: food?.food_type || "Generic",
      food_url: food?.food_url || null,
      brand_name: food?.brand_name || null,
      allergens: parseAllergens(food),
      preferences: parsePreferences(food),
      food_sub_categories: parseSubCategories(food),
      per100,
      image: imageUrl,
      type: "food",
    };

    return setCached(cacheKey, mapped);
  } catch (error) {
    const normalizedError = coerceFatSecretError(error, "Food detail lookup failed.");
    if (Number(normalizedError?.status) >= 500) {
      console.error("getFoodItemById Error:", normalizedError);
    }
    if (throwOnError) throw normalizedError;
    return null;
  }
};

export const getRecipeDetails = async (recipeId, options = {}) => {
  const { throwOnError = false } = options;
  if (!recipeId) return null;

  const cacheKey = makeCacheKey("recipe.get", [recipeId]);
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      method: "recipe.get",
      recipe_id: String(recipeId),
      format: "json",
      include_food_images: "true",
    });

    const data = await requestFatSecret(params);
    const recipe = data?.recipe;
    if (!recipe) return null;

    const serving = ensureArray(recipe?.serving_sizes?.serving)[0] || recipe?.serving_sizes?.serving || {};
    const mapped = {
      id: String(recipe.recipe_id),
      title: recipe.recipe_name,
      description: recipe.recipe_description || "",
      image: recipe.recipe_image || "",
      rating: recipe.rating || null,
      prepTime: Number.parseInt(recipe.preparation_time_min, 10) || 0,
      cookTime: Number.parseInt(recipe.cooking_time_min, 10) || 0,
      servings: Number.parseInt(recipe.number_of_servings, 10) || 1,
      calories: Number.parseFloat(serving?.calories) || 0,
      protein: Number.parseFloat(serving?.protein) || 0,
      carbs: Number.parseFloat(serving?.carbohydrate) || 0,
      fats: Number.parseFloat(serving?.fat) || 0,
      ingredients: ensureArray(recipe?.ingredients?.ingredient).map((ingredient) => {
        const cleanNumber = ingredient?.number_of_units
          ? Number.parseFloat(ingredient.number_of_units).toString()
          : "";

        return {
          id: ingredient?.food_id || null,
          name: ingredient?.food_name || "",
          quantity: `${cleanNumber} ${ingredient?.measurement_description || ""}`.trim(),
          description: ingredient?.ingredient_description || "",
          image: ingredient?.recipe_image || null,
        };
      }),
      instructions: ensureArray(recipe?.directions?.direction).map((step) => ({
        step: step?.direction_number || null,
        text: step?.direction_description || "",
      })),
      type: "recipe",
    };

    return setCached(cacheKey, mapped);
  } catch (error) {
    console.error("getRecipeDetails Error:", error);
    if (throwOnError) throw coerceFatSecretError(error, "Recipe detail lookup failed.");
    return null;
  }
};

export const getDetailedMacros = async (foodIds = []) => {
  const uniqueIds = uniqueStrings(ensureArray(foodIds)).slice(0, 25);
  if (uniqueIds.length === 0) return {};

  const details = await Promise.all(uniqueIds.map((foodId) => getFoodItemById(foodId)));
  const output = {};

  details.forEach((food) => {
    if (!food?.id) return;

    let per100 = food.per100;
    if (!per100 || Object.values(per100).every((value) => Number(value || 0) === 0)) {
      per100 = parseDescriptionMacros(food.serving_description || "");
    }

    output[String(food.id)] = {
      foodId: String(food.id),
      title: food.title,
      image: food.image || null,
      per100: {
        calories: Number(per100.calories || 0),
        protein: Number(per100.protein || 0),
        carbs: Number(per100.carbs || 0),
        fats: Number(per100.fats || 0),
      },
    };
  });

  return output;
};
