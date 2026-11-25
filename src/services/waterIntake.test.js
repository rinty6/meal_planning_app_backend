// Coverage for checklist m6-02: what counts toward the day's fluids
// (WATER_TOTAL_DESIGN.html section 4). Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { descriptionMl, drinkMlForLog, isDrinkName, summariseWater } from "./waterIntake.js";

const catalog = (externalId, foodName, servingDescription, extra = {}) => ({
  source: "catalog", externalId, foodName, servingDescription, servings: 1,
  nutrients: { serving_grams: 250, alcohol_g: 0 }, ...extra,
});

test("catalogue drinks count by their stated size (real rows from the log)", () => {
  assert.equal(drinkMlForLog(catalog("food_ausnut_11801001", "Water, tap", "1 glass (250 ml)")), 250);
  assert.equal(drinkMlForLog(catalog("food_ausnut_11302001", "Juice, apple & other fruits", "1 small bottle (250 ml)")), 250);
  // Milk: 260 g but 250 ml; the stated ml wins.
  assert.equal(drinkMlForLog(catalog("food_ausnut_19101005", "Milk, cow, fluid, skim (~0.1% fat)", "1 × 1 carton, small (250 ml)",
    { nutrients: { serving_grams: 260, alcohol_g: 0 } })), 250);
});

test("the plate multiplier and the servings column both scale the volume", () => {
  assert.equal(drinkMlForLog(catalog("food_ausnut_11801001", "Water, tap", "1½ × 1 glass (250 ml)")), 375);
  assert.equal(drinkMlForLog(catalog("food_ausnut_11801001", "Water, tap", "1 glass (250 ml)", { servings: 2 })), 500);
});

test("without a stated ml, an AUSNUT drink falls back to serving grams", () => {
  assert.equal(drinkMlForLog(catalog("food_ausnut_11201001", "Coffee, flat white", "1½ × 100 g",
    { nutrients: { serving_grams: 150, alcohol_g: 0 } })), 150);
});

test("branded drinks count only when the serving is written in ml", () => {
  assert.equal(drinkMlForLog(catalog("food_off_93556101", "Zero Sugar (Coca-Cola)", "1 bottle (300 ml)", { servings: 2 })), 600);
  // Woolworths milk logged as "250 g": unknown volume, so not counted.
  assert.equal(drinkMlForLog(catalog("food_off_9300633556181", "Australian Lite Fresh Milk (Woolworths)", "250 g")), 0);
});

test("food, alcohol, powders and non-catalogue rows never count", () => {
  assert.equal(drinkMlForLog(catalog("food_ausnut_12511011", "Muesli, commercial, toasted, dried fruit", "1 × 100 g")), 0);
  assert.equal(drinkMlForLog(catalog("food_ausnut_29201001", "Wine, red", "1 glass (150 ml)", { nutrients: { serving_grams: 150, alcohol_g: 14 } })), 0);
  assert.equal(drinkMlForLog(catalog("food_ausnut_11201010", "Coffee, instant, dry powder", "1 teaspoon (2 g)")), 0);
  assert.equal(drinkMlForLog({ source: "fatsecret_food", foodName: "Caffe Latte - Large", servingDescription: "1 serving" }), 0);
  assert.equal(drinkMlForLog({ source: null, foodName: "Oat Milk Latte" }), 0);
});

test("drink names: the made drink counts, the powder or concentrate does not", () => {
  assert.equal(isDrinkName("Chai latte, made with chai mix powder & cow's milk"), true);
  assert.equal(isDrinkName("Sports drink, made from dry powder & water, all flavours, standard dilution"), true);
  assert.equal(isDrinkName("Tea, green, dry"), false);
  assert.equal(isDrinkName("Beverage base, malted milk powder"), false);
  assert.equal(isDrinkName("Coffee & milk concentrate"), false);
  assert.equal(isDrinkName("Milk, evaporated, regular fat"), false);
});

test("ml in a description: millilitres, litres, and nothing for 'large'", () => {
  assert.equal(descriptionMl("1 small bottle (250 ml)"), 250);
  assert.equal(descriptionMl("1 bottle (1.25 L)"), 1250);
  assert.equal(descriptionMl("1 large (200 g)"), null);
});

test("the day: glasses plus drinks, and the newest glass is the one the minus takes back", () => {
  const day = summariseWater({
    glasses: [{ id: 4, ml: 250 }, { id: 9, ml: 250 }],
    logs: [catalog("food_ausnut_11302001", "Juice, orange", "1 small bottle (250 ml)")],
    targetMl: 2600,
  });
  assert.deepEqual(day, { targetMl: 2600, totalMl: 750, glassesMl: 500, drinksMl: 250, lastGlassId: 9 });
  assert.equal(summariseWater({ targetMl: 2100 }).lastGlassId, null);
});
