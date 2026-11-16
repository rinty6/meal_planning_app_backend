// Coverage for checklist m4-05: the shared meal split.
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MEAL_SPLIT, buildMealCalorieTargets, parseMealSplit } from "./mealSplit.js";

test("default split is 25/30/35/10 and sums to 1", () => {
  assert.deepEqual({ ...DEFAULT_MEAL_SPLIT }, { breakfast: 0.25, lunch: 0.3, dinner: 0.35, snack: 0.1 });
  const total = Object.values(DEFAULT_MEAL_SPLIT).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("all four slots get the split exactly", () => {
  assert.deepEqual(buildMealCalorieTargets(2000, { split: DEFAULT_MEAL_SPLIT }), {
    breakfast: 500, lunch: 600, dinner: 700, snack: 200,
  });
});

test("three slots are scaled up to cover the whole day (until the snack slot exists)", () => {
  const targets = buildMealCalorieTargets(2000, {
    slots: ["breakfast", "lunch", "dinner"],
    split: DEFAULT_MEAL_SPLIT,
  });
  // 25/90, 30/90, 35/90 of 2000
  assert.deepEqual(targets, { breakfast: 556, lunch: 667, dinner: 778 });
  const sum = Object.values(targets).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 2000) <= 2);
});

test("no slot is half the day any more", () => {
  const targets = buildMealCalorieTargets(2000, { slots: ["breakfast", "lunch", "dinner"], split: DEFAULT_MEAL_SPLIT });
  for (const kcal of Object.values(targets)) assert.ok(kcal < 1000);
});

test("a valid MEAL_SPLIT is used", () => {
  const { split, error } = parseMealSplit("25, 35, 30, 10");
  assert.equal(error, null);
  assert.deepEqual(buildMealCalorieTargets(2000, { split }), { breakfast: 500, lunch: 700, dinner: 600, snack: 200 });
});

test("missing or empty MEAL_SPLIT means the default, without an error", () => {
  for (const raw of [undefined, null, "", "   "]) {
    const { split, error } = parseMealSplit(raw);
    assert.equal(error, null);
    assert.equal(split, DEFAULT_MEAL_SPLIT);
  }
});

test("an invalid MEAL_SPLIT falls back to the default and says why", () => {
  for (const raw of ["25,30,35", "25,30,35,10,5", "25,30,abc,10", "25,30,35,-10", "30,30,30,30", "25,,35,40"]) {
    const { split, error } = parseMealSplit(raw);
    assert.equal(split, DEFAULT_MEAL_SPLIT, raw);
    assert.ok(error, `expected an error for "${raw}"`);
  }
});

test("unknown slots are ignored and a zero or bad target gives zeros", () => {
  assert.deepEqual(buildMealCalorieTargets(2000, { slots: ["dinner", "supper"], split: DEFAULT_MEAL_SPLIT }), { dinner: 2000 });
  assert.deepEqual(buildMealCalorieTargets(0, { slots: ["lunch"], split: DEFAULT_MEAL_SPLIT }), { lunch: 0 });
  assert.deepEqual(buildMealCalorieTargets("abc", { slots: ["lunch"], split: DEFAULT_MEAL_SPLIT }), { lunch: 0 });
});
