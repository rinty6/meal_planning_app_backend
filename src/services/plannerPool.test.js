// Coverage for checklist m5-01 step 1: the meal table and the planner pool.
// Pure tests only; the live load is checked by hand (read-only) on the laptop.
// Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { indexMealTable, kindFor, rolesFor, validateMealTable } from "./mealTable.js";
import {
  PLANNER_ALLERGEN_LABELS,
  buildPool,
  buildPoolSql,
  candidatesForMeal,
  mapPlannerAllergens,
  shortNameFor,
  toPoolFood,
} from "./plannerPool.js";
import { normalizeAllergens } from "./foodAttributeFilter.js";

// ---- meal table -----------------------------------------------------------

test("the approved table loads and has 104 groups", () => {
  // Fin fish is a lunch and dinner main; porridge a breakfast main.
  assert.deepEqual(rolesFor("ausnut-151", "dinner"), ["main"]);
  assert.deepEqual(rolesFor("ausnut-126", "breakfast"), ["main"]);
  assert.deepEqual(rolesFor("ausnut-126", "dinner"), []);
});

test("main/side expands to both roles", () => {
  assert.deepEqual(rolesFor("ausnut-249", "lunch"), ["main", "side"]);
});

test("drink and never groups have no plate roles", () => {
  assert.equal(kindFor("ausnut-118"), "drink"); // water
  assert.deepEqual(rolesFor("ausnut-118", "lunch"), []);
  assert.equal(kindFor("ausnut-292"), "never"); // wine
  assert.equal(kindFor("ausnut-301"), "never"); // meal replacements
});

test("a group missing from the table is never planned", () => {
  assert.equal(kindFor("ausnut-999"), "never");
  assert.deepEqual(rolesFor("ausnut-999", "lunch"), []);
});

test("a malformed table fails loudly", () => {
  assert.throws(() => validateMealTable({ rows: [] }));
  assert.throws(() => validateMealTable({ rows: [{ code: "x", kind: "plate", lunch: "starter" }] }));
  assert.throws(() => validateMealTable({ rows: [{ code: "x", kind: "never", lunch: "main" }] }));
  assert.throws(() => validateMealTable({ rows: [{ code: "x", kind: "plate" }, { code: "x", kind: "plate" }] }));
  const idx = indexMealTable({ rows: [{ code: "x", kind: "plate", snack: "main" }] });
  assert.deepEqual(rolesFor("x", "snack", idx), ["main"]);
});

// ---- allergen labels: the safety guard ------------------------------------

test("every allergen label the planner offers maps to something the filter understands", () => {
  const labels = ["Egg", "Fish", "Gluten", "Lactose", "Milk", "Nuts", "Peanuts", "Sesame", "Shellfish", "Soy"];
  for (const label of labels) {
    const { slugs, ignored } = normalizeAllergens(mapPlannerAllergens([label]));
    assert.deepEqual(ignored, [], label);
    assert.ok(slugs.length > 0, label);
  }
  assert.equal(Object.keys(PLANNER_ALLERGEN_LABELS).length, labels.length);
});

test("Nuts means every tree nut, and Peanuts means peanut", () => {
  const nuts = normalizeAllergens(mapPlannerAllergens(["Nuts"])).slugs;
  assert.ok(nuts.includes("almond") && nuts.includes("walnut") && nuts.includes("cashew"));
  assert.deepEqual(normalizeAllergens(mapPlannerAllergens(["Peanuts"])).slugs, ["peanut"]);
});

// ---- pool food shape ------------------------------------------------------

const row = (over = {}) => ({
  id: 1, public_id: "food_x", name: "Rice, brown, cooked", base_name: "rice",
  name_segments: ["brown", "cooked"], subgroup_code: "ausnut-121",
  basis_quantity: 167.5, energy_kj: 1160.8, calories_kcal: 277.4, protein_g: 6.9, fat_g: 1.8,
  saturated_fat_g: 0.4, carbohydrate_g: 56.1, sugar_g: 0.5, fiber_g: 2.8, sodium_mg: 3.4,
  vitamin_c_mg: null, alcohol_g: 0,
  grain_serves: 1.2, vegetable_serves: 0, fruit_serves: 0, dairy_serves: 0, protein_serves: 0,
  image_url: "https://example/rice.webp",
  servings: [{ description: "1 cup (250 ml)", grams: 167.5, is_default: true }, { description: "bad", grams: null }],
  verdicts: { milk: 0 },
  ...over,
});

test("nutrition becomes per 100 g, exactly", () => {
  const food = toPoolFood(row());
  assert.equal(food.per100g.energy_kj, 693.0149);
  assert.equal(food.per100g.protein_g, 4.1194);
  // 1 cup back from per 100 g gives the stored figure.
  assert.ok(Math.abs((food.per100g.energy_kj * 167.5) / 100 - 1160.8) < 0.01);
});

test("unknown nutrients stay null, never 0", () => {
  const food = toPoolFood(row());
  assert.equal(food.per100g.vitamin_c_mg, null);
  assert.equal(food.per100g.potassium_mg, null); // not in the row at all
  assert.equal(food.per100g.alcohol_g, 0); // a known zero stays zero
});

test("servings without grams are dropped", () => {
  assert.deepEqual(toPoolFood(row()).servings, [{ description: "1 cup (250 ml)", grams: 167.5, isDefault: true }]);
});

test("a row with no grams or no energy cannot be planned with", () => {
  assert.equal(toPoolFood(row({ basis_quantity: 0 })), null);
  assert.equal(toPoolFood(row({ energy_kj: null, calories_kcal: null })), null);
});

test("short names", () => {
  assert.equal(shortNameFor({ name: "Rice, brown, cooked", baseName: "rice", nameSegments: ["brown", "cooked"] }), "Brown rice");
  assert.equal(shortNameFor({ name: "Salmon, baked", baseName: "salmon", nameSegments: ["baked", "roasted"] }), "Salmon");
  assert.equal(shortNameFor({ name: "Kebab wrap, chicken, with salad", baseName: "kebab wrap", nameSegments: ["chicken"] }), "Chicken kebab wrap");
  assert.equal(shortNameFor({ name: "Milk, cow, fluid", baseName: "milk", nameSegments: ["cow", "fluid"] }), "Milk");
  assert.equal(shortNameFor({ name: "Apple, red skin, raw", baseName: "apple", nameSegments: ["red skin", "raw"] }), "Apple");
  assert.equal(shortNameFor({ name: "Tofu", baseName: null, nameSegments: [] }), "Tofu");
});

test("buildPool keeps only groups that go on plates", () => {
  const pool = buildPool([
    row(),
    row({ id: 2, subgroup_code: "ausnut-118" }), // water: drink slot
    row({ id: 3, subgroup_code: "ausnut-301" }), // meal replacement: never
    row({ id: 4, subgroup_code: "ausnut-999" }), // unknown group: never
  ]);
  assert.deepEqual(pool.map((f) => f.id), [1]);
});

test("the pool query excludes alcohol and discretionary foods and keeps only servable ones", () => {
  const text = JSON.stringify(buildPoolSql());
  assert.match(text, /servability = 'servable'/);
  assert.match(text, /coalesce\(p\.alcohol_g, 0\) = 0/);
  assert.match(text, /discretionary-food/);
});

// ---- per-user candidates --------------------------------------------------

const food = (id, group, verdicts = {}) => ({ id, group, verdicts });

test("candidates follow the meal's roles", () => {
  const pool = [food(1, "ausnut-151"), food(2, "ausnut-242"), food(3, "ausnut-126")];
  const dinner = candidatesForMeal(pool, "dinner");
  assert.deepEqual(dinner.mains.map((f) => f.id), [1]); // fish
  assert.deepEqual(dinner.sides.map((f) => f.id), [2]); // broccoli; porridge is breakfast only
});

test("an allergy removes foods that contain it AND foods whose status is unknown", () => {
  const pool = [
    food(1, "ausnut-222", { almond: 0, "brazil-nut": 0, cashew: 0, hazelnut: 0, macadamia: 0, pecan: 0, pistachio: 0, "pine-nut": 0, walnut: 0 }),
    food(2, "ausnut-222", { almond: 1 }),
    food(3, "ausnut-222", {}),
  ];
  const snack = candidatesForMeal(pool, "snack", { allergens: ["Nuts"] });
  assert.deepEqual(snack.mains.map((f) => f.id), [1]);
});

test("an unrecognised allergen or diet blocks plates instead of being ignored", () => {
  const pool = [food(1, "ausnut-151")];
  const result = candidatesForMeal(pool, "lunch", { allergens: ["Nutz"] });
  assert.deepEqual(result.blocked, ["Nutz"]);
  assert.equal(result.mains.length, 0);
  assert.deepEqual(candidatesForMeal(pool, "lunch", { diets: ["Paleo"] }).blocked, ["Paleo"]);
});

test("a vegetarian diet needs a positive vegetarian verdict", () => {
  const pool = [food(1, "ausnut-206", { vegetarian: 1 }), food(2, "ausnut-206", {})];
  assert.deepEqual(candidatesForMeal(pool, "lunch", { diets: ["Vegetarian"] }).mains.map((f) => f.id), [1]);
});
