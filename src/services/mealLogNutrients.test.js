// Coverage for task T1 (2026-11-21, m4-11): Meal Summary +/- rescales the
// stored nutrients. Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { scaleNutrients } from "./mealLogNutrients.js";

const stored = () => ({
  fiber_g: 4,
  alcohol_g: 13.8,
  sodium_mg: 300,
  vitamin_c_mg: null,
  serving_grams: 150,
  vitamin_a_convention: "RE",
});

test("1 -> 2 servings doubles fibre and alcohol_g", () => {
  const out = scaleNutrients(stored(), 1, 2);
  assert.equal(out.fiber_g, 8);
  assert.equal(out.alcohol_g, 27.6);
  assert.equal(out.sodium_mg, 600);
});

test("2 -> 0.5 servings quarters them", () => {
  const out = scaleNutrients(stored(), 2, 0.5);
  assert.equal(out.fiber_g, 1);
  assert.equal(out.alcohol_g, 3.45);
  assert.equal(out.sodium_mg, 75);
});

test("null stays null; serving_grams and vitamin_a_convention unchanged", () => {
  const out = scaleNutrients(stored(), 1, 3);
  assert.equal(out.vitamin_c_mg, null);
  assert.equal(out.serving_grams, 150);
  assert.equal(out.vitamin_a_convention, "RE");
});

test("rounds to 3 decimals", () => {
  assert.equal(scaleNutrients({ iron_mg: 1 }, 3, 1).iron_mg, 0.333);
});

test("oldServings 0 or missing changes nothing", () => {
  for (const old of [0, undefined, null, "x", -1]) {
    assert.deepEqual(scaleNutrients(stored(), old, 2), stored(), String(old));
  }
});

test("no nutrients stays no nutrients", () => {
  assert.equal(scaleNutrients(null, 1, 2), null);
  assert.equal(scaleNutrients(undefined, 1, 2), undefined);
});
