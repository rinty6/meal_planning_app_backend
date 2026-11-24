// Coverage for the most eaten food page (2026-11-24, MOST_EATEN_STRIP_DESIGN.html).
// Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { mergeKey } from "./mostConsumedMeals.js";
import { matchCatalogFood, titleTokens, usualGrams, usualPlateFor } from "./usualFoods.js";

let id = 1;
const food = (name, group, kcal, servings = [{ description: "1 serve", grams: 100, isDefault: true }]) => ({
  id: id++, publicId: `food_${id}`, name, shortName: name.split(",")[0], group, image: `img_${id}`,
  per100g: { calories_kcal: kcal, protein_g: 1, fat_g: 0.2, sugar_g: 12, sodium_mg: null }, servings,
});
const FOODS = [
  food("Banana, cavendish, peeled, raw", "ausnut-165", 95.4, [{ description: "1 banana, medium, sliced (127.4 g)", grams: 127.4, isDefault: true }]),
  food("Banana, cooked", "ausnut-165", 110),
  food("Egg, chicken, scotch", "ausnut-172", 220),
  food("Egg, chicken, whole, boiled", "ausnut-171", 140),
  food("Chicken, skin, baked, roasted, fried, grilled or BBQ'd, no added fat", "ausnut-183", 430),
  food("Chicken, nugget, takeaway outlet, grilled", "ausnut-189", 200),
  food("Chicken, lean, baked, roasted, fried, grilled or BBQ'd, no added fat", "ausnut-183", 141),
  food("Rice, white, fried, with vegetables", "ausnut-135", 200),
  food("Fried rice, commercial", "ausnut-135", 198),
];

test("Banana and Bananas are one food; different names stay apart", () => {
  assert.equal(mergeKey("Bananas"), mergeKey("banana"));
  assert.equal(mergeKey("Dry Egg Noodles"), mergeKey("dry egg noodle"));
  assert.notEqual(mergeKey("Pork loin, roasted"), mergeKey("Pork roast, top loin"));
  assert.equal(mergeKey("Glass"), "glass"); // "ss" is not a plural
});

test("matches the plain food, not a scotch egg, nuggets or chicken skin", () => {
  assert.equal(matchCatalogFood({ title: "Banana", calories: 105 }, FOODS).food.name, "Banana, cavendish, peeled, raw");
  assert.equal(matchCatalogFood({ title: "Egg", calories: 74 }, FOODS).food.name, "Egg, chicken, whole, boiled");
  assert.match(matchCatalogFood({ title: "Grilled Chicken", calories: 147 }, FOODS).food.name, /^Chicken, lean/);
  assert.equal(matchCatalogFood({ title: "Fried Rice", calories: 295 }, FOODS).food.name, "Fried rice, commercial");
});

test("no match: long dish names, missing words, unbelievable portions", () => {
  assert.equal(matchCatalogFood({ title: "Oriental Style Beef and Rice Noodle Soup (Vietnamese Pho Bo)", calories: 176 }, FOODS), null);
  assert.equal(matchCatalogFood({ title: "Fried tofu", calories: 35 }, FOODS), null);
  assert.equal(matchCatalogFood({ title: "Banana", calories: 2000 }, FOODS), null); // 2 kg of banana
  assert.deepEqual(titleTokens("Pork Roasts (Top Loin, Boneless)"), ["pork", "roast"]);
});

test("the usual portion comes from the logged energy", () => {
  assert.equal(usualGrams(105, FOODS[0]), 110.1);
  const plate = usualPlateFor({ title: "Banana", calories: 105, image: "logged.png" }, matchCatalogFood({ title: "Banana", calories: 105 }, FOODS));
  const [f] = plate.items;
  assert.equal(plate.type, "plate");
  assert.equal(plate.kind, "usual_food");
  assert.equal(f.source, "catalog");
  assert.equal(f.unitless, false);
  assert.equal(f.grams, 110.1);
  assert.equal(f.servings[0].description, "Your usual");
  assert.equal(f.servings[0].isDefault, true);
  assert.ok(f.servings.slice(1).every((s) => !s.isDefault));
  assert.equal(plate.image, "logged.png"); // the photo the user knows
  assert.equal(f.nutrients.sodium_mg, null); // unknown stays unknown
});

test("without a match, the page shows what was logged, unitless, with its own source", () => {
  const plate = usualPlateFor({ title: "Steamed Bun", calories: 141, protein: 3.18, carbs: 24.06, fats: 3.45, servingDescription: "3 servings", source: "fatsecret_food", externalId: "123" }, null);
  const [f] = plate.items;
  assert.equal(f.unitless, true);
  assert.equal(f.source, "fatsecret_food");
  assert.equal(f.externalId, "123");
  assert.equal(f.servings[0].description, "3 servings");
  assert.equal(f.per100g.calories_kcal, 141);
  assert.equal(f.per100g.sugar_g, undefined); // never invented
});
