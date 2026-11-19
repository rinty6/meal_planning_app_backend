// Catalogue plates for the planning screen (checklist m5-01, step 3).
//
// The bridge between the planner route and the plate builder: per meal it
// takes the in-memory pool, applies this user's allergens, diets and nutrient
// limits, turns their history into small tie-breakers, builds 5 plates and
// shapes each one into an item the app can render.
//
// Switched on by MEAL_PLAN_SOURCE=catalog. Without it the route keeps the old
// FatSecret path, so nothing changes until the variable is set on Railway
// (strangler rule: the old path is removed only after the new one is
// verified on a device).
//
// Personal signals stay title-keyed for now because meal_plan_events stores
// titles; moving them to food ids is m5-09. They only ever break near-ties
// (plateBuilder caps them), so a favourite can never outrank a plate that
// fits the target better.
import { drinksForPlate } from "./drinkPicker.js";
import { candidatesForMeal, getPlannerDrinks, getPlannerPool } from "./plannerPool.js";
import { buildPlates, seededRandom } from "./plateBuilder.js";
import { buildSnacks } from "./snackBuilder.js";

export const isCatalogPlannerEnabled = (env = process.env) =>
  String(env.MEAL_PLAN_SOURCE || "").trim().toLowerCase() === "catalog";

const titleKey = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// The filter screen's nutrient keys -> per-100 g pool fields.
const LIMIT_FIELDS = Object.freeze({
  calories: "calories_kcal", protein: "protein_g", carbs: "carbohydrate_g", fat: "fat_g",
  fiber: "fiber_g", sugar: "sugar_g", sodium: "sodium_mg", cholesterol: "cholesterol_mg",
});

/**
 * Nutrient limits, per 100 g of each food (how the old planner applied them).
 * Unknown fails closed: a sodium limit excludes a food whose sodium is unknown.
 */
export const passesNutrientLimits = (food, limits = {}) => {
  for (const [key, limit] of Object.entries(limits || {})) {
    const field = LIMIT_FIELDS[key];
    if (!field) continue;
    const value = food.per100g?.[field];
    if (value === null || value === undefined) return false;
    if (limit?.min !== undefined && value < Number(limit.min)) return false;
    if (limit?.max !== undefined && value > Number(limit.max)) return false;
  }
  return true;
};

/** Stable within a day, so the screen doesn't reshuffle on every visit; Shuffle passes its own. */
export const seedFor = (...parts) => {
  let hash = 2166136261;
  for (const ch of parts.join(":")) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  return hash || 1;
};

/**
 * Title-keyed history -> a tie-breaker per food, and foods the user skipped.
 * A food matches when its full name or its short name equals a signal title.
 */
export const personalSignals = ({ meal, favoriteTitles = [], mostConsumedByMeal = {}, eventProfile = {} } = {}) => {
  const favourites = new Set(favoriteTitles.map(titleKey));
  const history = new Set((mostConsumedByMeal?.[meal] || []).map((i) => titleKey(i?.title)));
  const liked = new Set([...(eventProfile.lovedTitles || []), ...(eventProfile.acceptedTitles || [])]);
  const skipped = new Set(eventProfile.skippedTitles || []);
  const keysOf = (food) => [titleKey(food.name), titleKey(food.shortName)].filter(Boolean);
  return {
    bonusFor: (food) => {
      const keys = keysOf(food);
      let bonus = 0;
      if (keys.some((k) => favourites.has(k))) bonus += 0.02;
      if (keys.some((k) => liked.has(k))) bonus += 0.015;
      if (keys.some((k) => history.has(k))) bonus += 0.01;
      return bonus;
    },
    isSkipped: (food) => keysOf(food).some((k) => skipped.has(k)),
  };
};

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
const fmtQty = (q) => (q === 0.5 ? "½" : q === 1.5 ? "1½" : String(q));

/**
 * A built plate -> the item shape the planning screen renders. Totals sit on
 * the item (title, calories, macros) so today's card can already show it; the
 * foods sit in `items` with everything needed to edit a portion on the phone.
 */
export const plateToItem = (plate, mealType) => {
  const n = plate.totals.nutrients;
  const main = plate.items[0];
  return {
    id: plate.id,
    combo_id: plate.id,
    title: plate.title,
    type: "plate",
    source: "catalog_plate",
    food_type: "Plate",
    mealType,
    // P2, 2026-11-20: "whole" | "needs_starch" | "meat_and_veg" | "cereal" |
    // "toast" | "eggs" | "snack" (plateShape.js). The app labels a whole dish
    // with one food "DISH".
    shape: plate.shape || null,
    calories: plate.totals.kcal,
    protein: round1(n.protein_g),
    carbs: round1(n.carbohydrate_g),
    fats: round1(n.fat_g),
    fiber: round1(n.fiber_g),
    sugar: round1(n.sugar_g),
    sodium: round1(n.sodium_mg),
    image: main?.image || plate.items.find((i) => i.image)?.image || "",
    serving_description: `${plate.items.length} foods`,
    items: plate.items.map((i) => ({
      id: i.publicId,
      food_id: i.publicId,
      externalId: i.publicId,
      source: "catalog",
      type: "food",
      role: i.role,
      title: i.shortName,
      food_name: i.name,
      calories: i.kcal,
      protein: round1(i.nutrients.protein_g),
      carbs: round1(i.nutrients.carbohydrate_g),
      fats: round1(i.nutrients.fat_g),
      grams: i.grams,
      image: i.image || "",
      quantity: i.quantity,
      serving: i.serving,
      serving_description: `${fmtQty(i.quantity)} × ${i.serving.description}`,
      servings: i.servings,
      per100g: i.per100g,
      nutrients: i.nutrients,
    })),
    plate: {
      target: plate.target,
      fit: plate.fit,
      serves: plate.totals.serves,
      // This meal's serve target and how much of it the plate covers (m5-03).
      // Not shown to users (m0-06); here for m6-03 and for checking plates.
      serve_target: plate.serveTarget,
      serve_coverage: plate.serveCoverage === null || plate.serveCoverage === undefined ? null : Math.round(plate.serveCoverage * 100) / 100,
      nutrients: plate.totals.nutrients,
    },
    calorie_target: plate.target,
    // P6, 2026-11-20: up to 3 optional drinks, the first is the card's
    // suggestion. They never change `calories`: the app adds a drink only
    // when the user turns it on, and logs it as one more catalogue row.
    drinks: (plate.drinks || []).map((d) => ({
      id: d.publicId,
      food_id: d.publicId,
      externalId: d.publicId,
      source: "catalog",
      type: "drink",
      kind: d.kind,
      title: d.shortName,
      food_name: d.name,
      calories: d.kcal,
      protein: round1(d.nutrients.protein_g),
      carbs: round1(d.nutrients.carbohydrate_g),
      fats: round1(d.nutrients.fat_g),
      grams: d.grams,
      image: d.image || "",
      quantity: 1,
      serving: { description: d.serving_description, grams: d.grams },
      serving_description: d.serving_description,
      nutrients: d.nutrients,
    })),
    explanation: "Built from the Australian food catalogue to fit this meal's energy target.",
    behavioral_insight: "Built from the Australian food catalogue to fit this meal's energy target.",
    ml_tag: "CATALOG_PLATE_V1",
  };
};

/**
 * Plates for the requested meals.
 *
 * @returns {Promise<{ recommendationsByMeal: object, blocked: string[], shortByMeal: object }>}
 *   blocked: allergen or diet labels that could not be understood. When set,
 *   no plates are returned at all: plates without that filter would be unsafe.
 */
export const buildCatalogRecommendations = async ({
  db,
  userId,
  dateStr,
  mealTypes,
  mealTargets,
  preferences = {},
  mostConsumedByMeal = {},
  favoriteTitles = [],
  eventProfile = {},
  explorationSeed,
  serveTargetsByMeal = {},
  person = {},
  getPool = getPlannerPool,
  getDrinks = getPlannerDrinks,
}) => {
  const pool = await getPool({ db });
  // P6, 2026-11-20: the drink list is loaded with the pool (same cache).
  const drinks = await getDrinks({ db });
  const recommendationsByMeal = { breakfast: [], lunch: [], dinner: [], snack: [] };
  const shortByMeal = {};
  let blocked = [];

  for (const meal of mealTypes) {
    const candidates = candidatesForMeal(pool, meal, {
      allergens: preferences.allergens || [],
      diets: preferences.diets || [],
    });
    if (candidates.blocked.length > 0) {
      blocked = candidates.blocked;
      break;
    }
    const limits = preferences.nutrientLimits || {};
    const mains = candidates.mains.filter((f) => passesNutrientLimits(f, limits));
    const sides = candidates.sides.filter((f) => passesNutrientLimits(f, limits));
    const { bonusFor, isSkipped } = personalSignals({ meal, favoriteTitles, mostConsumedByMeal, eventProfile });
    const excludeFoodIds = new Set([...mains, ...sides].filter(isSkipped).map((f) => f.id));
    const seed = explorationSeed ? seedFor(String(explorationSeed), meal) : seedFor(String(userId), dateStr, meal);

    // P4, 2026-11-20: the snack slot has its own builder (one food or a pair);
    // its result has the same shape as plates.
    const { plates, shortBy } = meal === "snack"
      ? buildSnacks({
        foods: [...mains, ...sides], targetKcal: mealTargets[meal], seed, bonusFor, excludeFoodIds,
        serveTarget: serveTargetsByMeal[meal] || null,
      })
      : buildPlates({
        mains, sides, meal, targetKcal: mealTargets[meal], seed, bonusFor, excludeFoodIds,
        serveTarget: serveTargetsByMeal[meal] || null,
      });
    // P6, 2026-11-20: one optional drink per card (DRINKS_UI.html), with the
    // same allergens and diets as the food. Juice on at most one card per meal.
    const drinkRand = seededRandom(seedFor(String(seed), "drinks"));
    const drinkPerson = { ...person, allergens: preferences.allergens || [], diets: preferences.diets || [] };
    let juiceUsed = false;
    for (const plate of plates) {
      plate.drinks = drinksForPlate({ drinks, meal, plate, person: drinkPerson, rand: drinkRand, juiceUsed });
      if (plate.drinks.some((d) => d.kind === "juice")) juiceUsed = true;
    }
    recommendationsByMeal[meal] = plates.map((p) => plateToItem(p, meal));
    shortByMeal[meal] = shortBy;
  }

  if (blocked.length > 0) {
    return { recommendationsByMeal: { breakfast: [], lunch: [], dinner: [], snack: [] }, blocked, shortByMeal: {} };
  }
  return { recommendationsByMeal, blocked, shortByMeal };
};
