// Coverage for checklist m4-07: the standard-drink budget.
// Limits are typed from the NHMRC alcohol guidelines, not read back from the
// module's constants, so a wrong constant fails here.
import test from "node:test";
import assert from "node:assert/strict";

import { resolveAlcoholBudget, standardDrinks, summariseAlcohol } from "./alcoholBudget.js";

const ADULT = { weeklyMax: 10, dailyMax: 4 };

test("healthy adults get 10 a week and 4 a day, whatever the gender", () => {
  for (const gender of ["male", "female", "other", null]) {
    const budget = resolveAlcoholBudget({ age: 30, gender });
    assert.equal(budget.weeklyMax, 10, String(gender));
    assert.equal(budget.dailyMax, 4, String(gender));
    assert.equal(budget.reason, "adult");
  }
});

test("under 18 is zero, and 18 is the first adult year", () => {
  assert.deepEqual(
    [16, 17, 18].map((age) => resolveAlcoholBudget({ age, gender: "female" }).weeklyMax),
    [0, 0, 10]
  );
  assert.equal(resolveAlcoholBudget({ age: 17, gender: "male" }).reason, "under_18");
});

test("pregnant or breastfeeding is zero at every age", () => {
  for (const age of [18, 30, 52]) {
    assert.equal(resolveAlcoholBudget({ age, gender: "female", isPregnant: true }).reason, "pregnant");
    assert.equal(resolveAlcoholBudget({ age, gender: "female", isBreastfeeding: true }).reason, "breastfeeding");
    assert.equal(resolveAlcoholBudget({ age, gender: "other", isBreastfeeding: true }).weeklyMax, 0);
  }
  const both = resolveAlcoholBudget({ age: 30, gender: "female", isPregnant: true, isBreastfeeding: true });
  assert.equal(both.weeklyMax, 0);
  assert.equal(both.dailyMax, 0);
});

test("a stale pregnancy answer is ignored for a male user, as in every other target", () => {
  assert.equal(resolveAlcoholBudget({ age: 30, gender: "male", isPregnant: true }).weeklyMax, 10);
});

test("unknown age is zero, never the adult limits", () => {
  for (const age of [undefined, null, 0, NaN]) {
    const budget = resolveAlcoholBudget({ age, gender: "male" });
    assert.equal(budget.weeklyMax, 0);
    assert.equal(budget.reason, "age_unknown");
    assert.equal(budget.source, "nhmrc_default");
  }
});

test("standard drinks come from alcohol grams, and missing alcohol is null not zero", () => {
  // NHMRC: 100 mL of 13% wine is one standard drink. 13% v/v x 0.789 g/mL is
  // 10.3 g per 100 mL.
  assert.ok(Math.abs(standardDrinks(10.3, 100) - 1.03) < 1e-9);
  assert.equal(standardDrinks(0, 250), 0);
  assert.equal(standardDrinks(null, 250), null);
  assert.equal(standardDrinks(undefined, 250), null);
});

test("the week is the day itself and the six days before it", () => {
  const result = summariseAlcohol({
    budget: ADULT,
    date: "2026-11-16",
    drinksByDate: { "2026-11-09": 5, "2026-11-10": 2, "2026-11-16": 1, "2026-11-17": 9 },
  });
  // 11-09 is 7 days back, outside; 11-17 is the future, outside.
  assert.equal(result.windowStart, "2026-11-10");
  assert.equal(result.weekUsed, 3);
  assert.equal(result.todayUsed, 1);
});

test("a calendar-week reset cannot be used to double up", () => {
  // 10 on Sunday leaves nothing for Monday, even though Monday starts a new
  // calendar week.
  const monday = summariseAlcohol({ budget: ADULT, date: "2026-11-16", drinksByDate: { "2026-11-15": 10 } });
  assert.equal(monday.dailyRemaining, 0);
  assert.equal(monday.weeklyRemaining, 0);
});

test("today's room is whichever limit is closer", () => {
  const plenty = summariseAlcohol({ budget: ADULT, date: "2026-11-16", drinksByDate: {} });
  assert.equal(plenty.dailyRemaining, 4);
  const weekNearlyUsed = summariseAlcohol({ budget: ADULT, date: "2026-11-16", drinksByDate: { "2026-11-12": 8.5 } });
  assert.equal(weekNearlyUsed.dailyRemaining, 1.5);
  const dayStarted = summariseAlcohol({ budget: ADULT, date: "2026-11-16", drinksByDate: { "2026-11-16": 3 } });
  assert.equal(dayStarted.dailyRemaining, 1);
});

test("over-limit flags, with float noise not counted as over", () => {
  const exactlyFour = summariseAlcohol({ budget: ADULT, date: "2026-11-16", drinksByDate: { "2026-11-16": 0.1 * 40 } });
  assert.equal(exactlyFour.overDaily, false);
  const over = summariseAlcohol({
    budget: ADULT,
    date: "2026-11-16",
    drinksByDate: { "2026-11-14": 6, "2026-11-16": 5 },
  });
  assert.equal(over.overDaily, true);
  assert.equal(over.overWeekly, true);
  assert.equal(over.dailyRemaining, 0);
});

test("any drink at all is over a zero budget", () => {
  const result = summariseAlcohol({
    budget: { weeklyMax: 0, dailyMax: 0 },
    date: "2026-11-16",
    drinksByDate: { "2026-11-16": 0.5 },
  });
  assert.equal(result.overDaily, true);
  assert.equal(result.overWeekly, true);
});

test("the window crosses month and year ends correctly", () => {
  const result = summariseAlcohol({ budget: ADULT, date: "2026-01-02", drinksByDate: { "2025-12-27": 2, "2025-12-26": 7 } });
  assert.equal(result.windowStart, "2025-12-27");
  assert.equal(result.weekUsed, 2);
});

test("a bad date is refused rather than silently giving a full budget", () => {
  assert.throws(() => summariseAlcohol({ budget: ADULT, date: "16/11/2026" }));
});
