import { desc, eq } from "drizzle-orm";
import { db } from "../config/db.js";
import { mealLogsTable } from "../db/schema.js";
import { MEAL_TYPES } from "./mealTypes.js";
import { getPlannerDrinks, getPlannerPool } from "./plannerPool.js";
import { matchCatalogFood, singular, usualPlateFor } from "./usualFoods.js";

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
    existing.titleVariants.set(rawTitle, (existing.titleVariants.get(rawTitle) || 0) + 1);
    return;
  }

  const item = createAggregateItem(meal, rawTitle, mealType);
  item.titleVariants = new Map([[rawTitle, 1]]);
  aggregateMap.set(key, item);
};

// 2026-11-24 (decision D3, MOST_EATEN_STRIP_DESIGN.html): "Banana" (54) and
// "Bananas" (28) are one food. Only letter case, spacing and a plural last
// word merge; different names stay apart.
export const mergeKey = (title) => {
  const words = normalizeKey(title).split(" ").filter(Boolean);
  if (words.length > 0) words[words.length - 1] = singular(words[words.length - 1]);
  return words.join(" ");
};

// The name a merged food shows: the spelling the user logged most often.
const finishAggregate = ({ titleVariants, ...item }) => {
  if (!titleVariants) return item;
  const [title] = [...titleVariants.entries()].sort((a, b) => b[1] - a[1])[0];
  return { ...item, title, food_name: title };
};

const sortMostConsumed = (items) =>
  items
    .map((item) => ({ ...item, number_appearance: item.count }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return String(left.title || "").localeCompare(String(right.title || ""));
    });

/**
 * Each strip item gets `usual_plate`, the one-food plate its food page opens
 * (usualFoods.js, decision D1). The catalogue match uses the planner's cached
 * pool and drinks; if they cannot load, every item still gets a plate built
 * from what the user logged.
 */
const withUsualPlates = async (items) => {
  let foods = [];
  try {
    const [pool, drinks] = await Promise.all([getPlannerPool({ db }), getPlannerDrinks({ db })]);
    foods = [...pool, ...drinks];
  } catch (error) {
    console.warn("[mostConsumedMeals] catalogue unavailable; usual plates from the log only", error?.message || error);
  }
  return items.map((item) => ({ ...item, usual_plate: usualPlateFor(item, matchCatalogFood(item, foods)) }));
};

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

    // Grouped by food name, with case and a plural last word merged (D3).
    const globalKey = mergeKey(rawTitle);
    if (!globalKey) continue;

    const mealType = normalizeMealType(meal.mealType);
    addMealToAggregate(globalAggregates, globalKey, meal, rawTitle, mealType);

    if (mealType) {
      addMealToAggregate(byMealAggregates, `${mealType}:${globalKey}`, meal, rawTitle, mealType);
    }
  }

  const allItems = sortMostConsumed(Array.from(globalAggregates.values(), finishAggregate));
  const byMealItems = sortMostConsumed(Array.from(byMealAggregates.values(), finishAggregate));

  return {
    all: await withUsualPlates(allItems.slice(0, safeLimit)),
    byMeal: Object.fromEntries(
      MEAL_TYPES.map((mealType) => [
        mealType,
        byMealItems.filter((item) => item.meal_type === mealType).slice(0, safeByMealLimit),
      ])
    ),
  };
};
