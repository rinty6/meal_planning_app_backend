// Coverage for checklist m4-09, decision D4: snack is a fourth slot in the
// meal pattern, and a day without a snack is never counted against it.
// Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { buildCalorieInsights } from "./calorieInsights.js";

const log = (date, mealType, calories) => ({ date, mealType, calories, foodName: "Test food" });

const MEALS = [
  log("2026-11-10", "breakfast", 400),
  log("2026-11-10", "lunch", 600),
  log("2026-11-10", "dinner", 700),
  log("2026-11-10", "snack", 150),
  log("2026-11-10", "snack", 50),
  log("2026-11-11", "breakfast", 400),
  log("2026-11-11", "lunch", 600),
  log("2026-11-11", "dinner", 700),
  log("2026-11-12", "breakfast", 400),
  log("2026-11-12", "lunch", 600),
  log("2026-11-12", "dinner", 700),
];

const insights = () =>
  buildCalorieInsights({ referenceDate: "2026-11-12", windowDays: 7, meals: MEALS });

test("meal pattern has four slots in the shared order", () => {
  const { averages } = insights().mealPattern;
  assert.deepEqual(averages.map((slot) => slot.mealType), ["breakfast", "lunch", "dinner", "snack"]);
});

test("snack is averaged over the days it was logged, not over every day", () => {
  const snack = insights().mealPattern.averages.find((slot) => slot.mealType === "snack");
  // One snack day with 200 total. Two days without a snack add nothing.
  assert.equal(snack.loggedCount, 1);
  assert.equal(snack.totalCalories, 200);
  assert.equal(snack.averageCalories, 200);
});

test("a small snack does not displace the largest meal", () => {
  assert.equal(insights().mealPattern.peakMealType.mealType, "dinner");
});

test("snack logs count toward the day total", () => {
  const day = insights().dailyBreakdown.find((entry) => entry.date === "2026-11-10");
  assert.equal(day.consumedCalories, 1900);
  assert.equal(day.mealCount, 5);
});

test("a snack-only history still produces a pattern, with no skip wording", () => {
  const result = buildCalorieInsights({
    referenceDate: "2026-11-12",
    windowDays: 7,
    meals: [log("2026-11-12", "snack", 200)],
  }).mealPattern;
  assert.equal(result.peakMealType.mealType, "snack");
  assert.doesNotMatch(`${result.summary} ${result.detail}`, /skip|miss/i);
});
