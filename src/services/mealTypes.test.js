// Coverage for checklist m4-09: the shared meal-type list.
// Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { MEAL_TYPES, isMealType } from "./mealTypes.js";
import { MEAL_SLOTS } from "./mealSplit.js";

test("order is breakfast, lunch, dinner, snack", () => {
  assert.deepEqual([...MEAL_TYPES], ["breakfast", "lunch", "dinner", "snack"]);
});

test("the list is frozen", () => {
  assert.ok(Object.isFrozen(MEAL_TYPES));
});

test("mealSplit slots are the same list", () => {
  assert.equal(MEAL_SLOTS, MEAL_TYPES);
});

test("isMealType ignores case and outer spaces", () => {
  assert.equal(isMealType("snack"), true);
  assert.equal(isMealType("Snack"), true);
  assert.equal(isMealType(" DINNER "), true);
});

test("isMealType rejects anything else", () => {
  assert.equal(isMealType("supper"), false);
  assert.equal(isMealType(""), false);
  assert.equal(isMealType(null), false);
  assert.equal(isMealType(undefined), false);
  assert.equal(isMealType(3), false);
});
