// Regression coverage for the calorie-target contract used by Home, Calorie
// Summary, Meal Planning recommendations, and meal-add threshold notifications.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DAILY_CALORIES,
  MIN_DAILY_CALORIES,
  estimateDailyCaloriesFromDemographics,
  resolveDailyCalorieTarget,
} from "./dailyCalorieTarget.js";

const TODAY = new Date(2026, 6, 15);
const DATE = "2026-07-15";

const demographics = {
  gender: "male",
  dateOfBirth: new Date(1996, 0, 1),
  weight: 80,
  height: 180,
  preferredWeightUnit: "kg",
  preferredHeightUnit: "cm",
  activityLevel: "moderately_active",
  goal: "maintain",
};

test("estimates the onboarding baseline from demographics", () => {
  assert.equal(estimateDailyCaloriesFromDemographics(demographics, { today: TODAY }), 2759);
});

test("the newest active goal overrides the onboarding baseline", () => {
  const result = resolveDailyCalorieTarget({
    dateStr: DATE,
    demographics,
    today: TODAY,
    goals: [
      {
        id: 1,
        dailyCalories: 2100,
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: 2,
        dailyCalories: 1850,
        startDate: "2026-07-10",
        endDate: "2026-07-20",
        createdAt: "2026-07-10T00:00:00.000Z",
      },
    ],
  });

  assert.equal(result.source, "goal");
  assert.equal(result.dailyCalories, 1850);
  assert.equal(result.goalRecord.id, 2);
});

test("an expired or future goal falls back to the onboarding baseline", () => {
  const result = resolveDailyCalorieTarget({
    dateStr: DATE,
    demographics,
    today: TODAY,
    goals: [
      { id: 1, dailyCalories: 1700, startDate: "2026-06-01", endDate: "2026-06-30" },
      { id: 2, dailyCalories: 1900, startDate: "2026-08-01", endDate: "2026-08-31" },
    ],
  });

  assert.equal(result.source, "bmr");
  assert.equal(result.dailyCalories, 2759);
});

test("missing demographics uses the hardcoded fallback", () => {
  const result = resolveDailyCalorieTarget({ dateStr: DATE, goals: [], demographics: null, today: TODAY });

  assert.equal(result.source, "default");
  assert.equal(result.dailyCalories, DEFAULT_DAILY_CALORIES);
});

test("estimated and explicit targets respect the minimum", () => {
  const lowEstimate = estimateDailyCaloriesFromDemographics(
    {
      gender: "female",
      dateOfBirth: new Date(1946, 0, 1),
      weight: 45,
      height: 150,
      preferredWeightUnit: "kg",
      preferredHeightUnit: "cm",
      activityLevel: "lightly_active",
      goal: "lose_weight",
    },
    { today: TODAY }
  );
  const lowGoal = resolveDailyCalorieTarget({
    dateStr: DATE,
    demographics,
    today: TODAY,
    goals: [{ id: 1, dailyCalories: 800, startDate: DATE, endDate: DATE }],
  });

  assert.equal(lowEstimate, MIN_DAILY_CALORIES);
  assert.equal(lowGoal.dailyCalories, MIN_DAILY_CALORIES);
});
