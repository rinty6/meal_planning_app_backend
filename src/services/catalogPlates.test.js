// Coverage for checklist m5-01 step 3: catalogue plates for the planner route.
// A fake in-memory pool, so no database is needed. Throwaway sprint test
// (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCatalogRecommendations,
  isCatalogPlannerEnabled,
  passesNutrientLimits,
  personalSignals,
  plateToItem,
  seedFor,
} from "./catalogPlates.js";

const NUT_FREE = { almond: 0, "brazil-nut": 0, cashew: 0, hazelnut: 0, macadamia: 0, pecan: 0, pistachio: 0, "pine-nut": 0, walnut: 0 };

let id = 1;
const food = (name, group, kcal, serves, verdicts = NUT_FREE, extra = {}) => ({
  id: id++,
  publicId: `food_${id}`,
  name,
  shortName: name.split(",")[0],
  group,
  image: `https://img/${id}.webp`,
  per100g: { calories_kcal: kcal, energy_kj: kcal * 4.184, protein_g: 10, carbohydrate_g: 10, fat_g: 5, sodium_mg: 100, fiber_g: 2, sugar_g: 1, ...extra },
  serves100g: { grain: 0, vegetable: 0, fruit: 0, dairy: 0, protein: 0, ...serves },
  servings: [{ description: "1 serve (150 g)", grams: 150, isDefault: true }],
  verdicts,
});

// Enough variety for 5 plates in each of the three meals.
const fakePool = () => [
  ...["ausnut-151", "ausnut-183", "ausnut-181", "ausnut-206", "ausnut-152", "ausnut-187"].map((g, i) =>
    food(`Main${i}, cooked`, g, 220, { protein: 1 })),
  ...["ausnut-125", "ausnut-126", "ausnut-171", "ausnut-172", "ausnut-136"].map((g, i) =>
    food(`Brekkie${i}, plain`, g, 250, { grain: 1 })),
  ...Array.from({ length: 6 }, (_, i) => food(`Veg${i}, steamed`, "ausnut-242", 35, { vegetable: 1.3 })),
  ...Array.from({ length: 6 }, (_, i) => food(`Fruit${i}, raw`, "ausnut-161", 55, { fruit: 1 })),
  ...Array.from({ length: 4 }, (_, i) => food(`Grain${i}, cooked`, "ausnut-121", 140, { grain: 1.3 })),
  ...Array.from({ length: 4 }, (_, i) => food(`Yoghurt${i}, natural`, "ausnut-192", 90, { dairy: 1 })),
  // P2, 2026-11-20: an egg plate needs bread (plateShape.js), so the pool has some.
  ...Array.from({ length: 2 }, (_, i) => food(`Bread${i}, wholemeal, toasted`, "ausnut-122", 250, { grain: 2 })),
  food("Almond, raw", "ausnut-222", 600, { protein: 1 }, { almond: 1 }),
];

const targets = { breakfast: 550, lunch: 650, dinner: 750 };
// Built once: the real pool is loaded once and reused, and ids must stay put
// for "same day, same plates" to mean anything.
const POOL = fakePool();
const run = (over = {}) => buildCatalogRecommendations({
  db: null,
  userId: 7,
  dateStr: "2026-11-19",
  mealTypes: ["breakfast", "lunch", "dinner"],
  mealTargets: targets,
  getPool: async () => POOL,
  ...over,
});

test("the switch is MEAL_PLAN_SOURCE=catalog and nothing else", () => {
  assert.equal(isCatalogPlannerEnabled({ MEAL_PLAN_SOURCE: "catalog" }), true);
  assert.equal(isCatalogPlannerEnabled({ MEAL_PLAN_SOURCE: " Catalog " }), true);
  assert.equal(isCatalogPlannerEnabled({ MEAL_PLAN_SOURCE: "fatsecret" }), false);
  assert.equal(isCatalogPlannerEnabled({}), false);
});

test("five plates for each meal, near each target", async () => {
  const { recommendationsByMeal, blocked } = await run();
  assert.deepEqual(blocked, []);
  for (const meal of ["breakfast", "lunch", "dinner"]) {
    assert.equal(recommendationsByMeal[meal].length, 5, meal);
    for (const item of recommendationsByMeal[meal]) {
      assert.ok(Math.abs(item.calories - targets[meal]) / targets[meal] < 0.25, `${meal} ${item.title} ${item.calories}`);
    }
  }
});

test("a Nuts allergy keeps every tree nut off every plate", async () => {
  const { recommendationsByMeal } = await run({ preferences: { allergens: ["Nuts"] } });
  const names = Object.values(recommendationsByMeal).flat().flatMap((p) => p.items.map((i) => i.food_name));
  assert.ok(names.length > 0);
  assert.ok(!names.some((n) => /almond/i.test(n)));
});

test("an unrecognised label returns no plates at all, and says which", async () => {
  const { recommendationsByMeal, blocked } = await run({ preferences: { allergens: ["Nutz"] } });
  assert.deepEqual(blocked, ["Nutz"]);
  assert.equal(Object.values(recommendationsByMeal).flat().length, 0);
});

test("only the requested meals are built", async () => {
  const { recommendationsByMeal } = await run({ mealTypes: ["dinner"] });
  assert.equal(recommendationsByMeal.breakfast.length, 0);
  assert.equal(recommendationsByMeal.dinner.length, 5);
});

test("the same day gives the same plates; Shuffle's seed changes them", async () => {
  const a = (await run()).recommendationsByMeal.dinner.map((p) => p.id);
  const b = (await run()).recommendationsByMeal.dinner.map((p) => p.id);
  assert.deepEqual(a, b);
  assert.notEqual(seedFor("7", "2026-11-19", "dinner"), seedFor("7", "2026-11-20", "dinner"));
});

test("a food the user skipped is never used", async () => {
  const { recommendationsByMeal } = await run({ eventProfile: { skippedTitles: new Set(["veg0 steamed", "veg0"]) } });
  const names = Object.values(recommendationsByMeal).flat().flatMap((p) => p.items.map((i) => i.food_name));
  assert.ok(!names.includes("Veg0, steamed"));
});

test("personal signals are small tie-breakers keyed by name or short name", () => {
  const { bonusFor, isSkipped } = personalSignals({
    meal: "dinner",
    favoriteTitles: ["Salmon"],
    mostConsumedByMeal: { dinner: [{ title: "Rice, brown, cooked" }] },
    eventProfile: { lovedTitles: new Set(), acceptedTitles: new Set(), skippedTitles: new Set(["tofu"]) },
  });
  assert.equal(bonusFor({ name: "Salmon, baked", shortName: "Salmon" }), 0.02);
  assert.equal(bonusFor({ name: "Rice, brown, cooked", shortName: "Brown rice" }), 0.01);
  assert.equal(bonusFor({ name: "Pork, roast", shortName: "Pork" }), 0);
  assert.equal(isSkipped({ name: "Tofu, firm", shortName: "Tofu" }), true);
});

test("nutrient limits apply per 100 g, and unknown fails closed", () => {
  const f = { per100g: { sodium_mg: 300, sugar_g: null } };
  assert.equal(passesNutrientLimits(f, { sodium: { max: 400 } }), true);
  assert.equal(passesNutrientLimits(f, { sodium: { max: 200 } }), false);
  assert.equal(passesNutrientLimits(f, { sugar: { max: 10 } }), false); // unknown
  assert.equal(passesNutrientLimits(f, {}), true);
});

test("an item carries totals for today's card and foods for editing", async () => {
  const [item] = (await run()).recommendationsByMeal.dinner;
  assert.equal(item.source, "catalog_plate");
  assert.equal(item.food_type, "Plate");
  assert.ok(item.title && item.calories > 0 && item.image);
  assert.ok(item.items.length >= 2);
  const totalKcal = item.items.reduce((s, i) => s + i.calories, 0);
  assert.ok(Math.abs(totalKcal - item.calories) <= item.items.length); // rounding only
  const first = item.items[0];
  assert.equal(first.role, "main");
  assert.equal(first.source, "catalog");
  assert.ok(first.per100g && Array.isArray(first.servings) && first.serving_description.includes("×"));
});

test("plateToItem writes half portions as ½", () => {
  const item = plateToItem({
    id: "p", title: "T", target: 500, fit: 1,
    totals: { kcal: 500, nutrients: { protein_g: 1, carbohydrate_g: 2, fat_g: 3 }, serves: {} },
    items: [{ publicId: "food_a", shortName: "A", name: "A", role: "main", kcal: 500, grams: 75, quantity: 0.5,
      serving: { description: "1 fillet (150 g)", grams: 150 }, servings: [], per100g: {}, nutrients: {}, image: null }],
  }, "dinner");
  assert.equal(item.items[0].serving_description, "½ × 1 fillet (150 g)");
});
