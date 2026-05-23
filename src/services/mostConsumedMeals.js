import { desc, eq } from "drizzle-orm";
import { db } from "../config/db.js";
import { mealLogsTable } from "../db/schema.js";

const MEAL_TYPES = ["breakfast", "lunch", "dinner"];

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeWhitespace = (value) => String(value || "").replace(/\s+/g, " ").trim();

const normalizeKey = (value) => normalizeWhitespace(value).toLowerCase();

const titleKey = (value) => normalizeKey(value).replace(/[^a-z0-9]+/g, " ").trim();

const normalizeMealType = (value) => {
  const next = normalizeKey(value);
  return MEAL_TYPES.includes(next) ? next : "";
};

const createAggregateItem = (meal, rawTitle, mealType) => {
  const externalId = normalizeWhitespace(meal.externalId);
  const source = normalizeKey(meal.source);
  const isFatSecretFood = source === "fatsecret_food";
  const isFatSecretRecipe = source === "fatsecret_recipe";
  const displayId = isFatSecretFood
    ? externalId
    : isFatSecretRecipe && externalId
      ? `recipe-${externalId}`
      : externalId
        ? `local-${externalId}`
        : "";

  return {
    id: displayId,
    food_id: isFatSecretFood ? externalId : "",
    fatsecret_food_id: isFatSecretFood ? externalId : "",
    recipe_id: isFatSecretRecipe ? externalId : "",
    title: rawTitle,
    food_name: rawTitle,
    meal_type: mealType || meal.mealType || "",
    count: 1,
    number_appearance: 1,
    image: meal.image || "",
    externalId,
    source: meal.source || "",
    servingId: meal.servingId || "",
    servingDescription: meal.servingDescription || "",
    nutrients: meal.nutrients || {},
    calories: toNumber(meal.calories),
    protein: toNumber(meal.protein),
    carbs: toNumber(meal.carbs),
    fats: toNumber(meal.fats),
  };
};

const addMealToAggregate = (aggregateMap, key, meal, rawTitle, mealType) => {
  const existing = aggregateMap.get(key);
  if (existing) {
    existing.count += 1;
    existing.number_appearance = existing.count;
    if (!existing.image && meal.image) existing.image = meal.image;
    return;
  }

  aggregateMap.set(key, createAggregateItem(meal, rawTitle, mealType));
};

const sortMostConsumed = (items) =>
  items
    .map((item) => ({ ...item, number_appearance: item.count }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return String(left.title || "").localeCompare(String(right.title || ""));
    });

export const getMostConsumedForUser = async (userId, { limit = 10, byMealLimit = 5 } = {}) => {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const safeByMealLimit = Math.max(1, Math.min(20, Number(byMealLimit) || 5));

  const meals = await db
    .select()
    .from(mealLogsTable)
    .where(eq(mealLogsTable.userId, userId))
    .orderBy(desc(mealLogsTable.createdAt));

  const globalAggregates = new Map();
  const byMealAggregates = new Map();

  for (const meal of meals) {
    const rawTitle = normalizeWhitespace(meal.foodName);
    if (!rawTitle) continue;

    // Global strip counts should match the user's SQL grouped by food_name.
    const globalKey = rawTitle;
    if (!globalKey) continue;

    const mealType = normalizeMealType(meal.mealType);
    addMealToAggregate(globalAggregates, globalKey, meal, rawTitle, mealType);

    if (mealType) {
      addMealToAggregate(byMealAggregates, `${mealType}:${globalKey}`, meal, rawTitle, mealType);
    }
  }

  const allItems = sortMostConsumed(Array.from(globalAggregates.values()));
  const byMealItems = sortMostConsumed(Array.from(byMealAggregates.values()));

  return {
    all: allItems.slice(0, safeLimit),
    byMeal: Object.fromEntries(
      MEAL_TYPES.map((mealType) => [
        mealType,
        byMealItems.filter((item) => item.meal_type === mealType).slice(0, safeByMealLimit),
      ])
    ),
  };
};
