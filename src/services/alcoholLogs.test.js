// Coverage for checklist m4-10: standard drinks read from meal logs.
// Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { drinksByDateFromLogs, getAlcoholSummary, standardDrinksForLog } from "./alcoholLogs.js";
import { resolveAlcoholBudget } from "./alcoholBudget.js";

const DAY = "2026-11-17";
const log = (date, alcohol_g, extra = {}) => ({
  date,
  nutrients: alcohol_g === undefined ? {} : { alcohol_g },
  ...extra,
});

const ADULT = resolveAlcoholBudget({ age: 30, gender: "male" });
const ZERO = resolveAlcoholBudget({ age: 16, gender: "male" });

/** Stands in for drizzle: select().from().where() resolves to `rows`. */
const fakeDb = (rows) => {
  const calls = [];
  const chain = {
    select: (fields) => (calls.push(["select", fields]), chain),
    from: (table) => (calls.push(["from", table]), chain),
    where: (condition) => (calls.push(["where", condition]), Promise.resolve(rows)),
  };
  return { db: chain, calls };
};

test("a 330 mL full-strength beer can (11.94 g) is 1.19 standard drinks", () => {
  const { drinks } = standardDrinksForLog(log(DAY, 11.94));
  assert.equal(Math.round(drinks * 100) / 100, 1.19);
});

test("0 g is a known zero, not unknown", () => {
  assert.deepEqual(standardDrinksForLog(log(DAY, 0)), { drinks: 0 });
});

test("missing or null alcohol_g is unknown", () => {
  assert.deepEqual(standardDrinksForLog(log(DAY, undefined)), { drinks: null });
  assert.deepEqual(standardDrinksForLog(log(DAY, null)), { drinks: null });
  assert.deepEqual(standardDrinksForLog({ date: DAY }), { drinks: null });
  assert.deepEqual(standardDrinksForLog(log(DAY, "")), { drinks: null });
});

test("unknown logs are counted per day, never added to drinks", () => {
  const result = drinksByDateFromLogs([log(DAY, 20), log(DAY, null), log(DAY, undefined), log(DAY, 0)]);
  assert.deepEqual(result.drinksByDate, { [DAY]: 2 });
  assert.deepEqual(result.unknownByDate, { [DAY]: 2 });
});

test("alcohol_g is the row TOTAL, like calories: servings never multiplies it again", () => {
  // Two cans logged as servings=2: the mapper already stored 2 x 11.94 g.
  const { drinks } = standardDrinksForLog(log(DAY, 23.88, { servings: 2 }));
  assert.equal(Math.round(drinks * 100) / 100, 2.39);
});

test("the 7-day window holds day -6 and the day itself, not day -7", async () => {
  const { db } = fakeDb([
    log("2026-11-10", 30), // day -7: outside
    log("2026-11-11", 20), // day -6: inside
    log(DAY, 10),
    log("2026-11-10", null), // unknown outside
    log("2026-11-12", null), // unknown inside
  ]);
  const summary = await getAlcoholSummary({ db, userId: 1, date: DAY, budget: ADULT });
  assert.equal(summary.windowStart, "2026-11-11");
  assert.equal(summary.windowEnd, DAY);
  assert.equal(summary.weekUsed, 3);
  assert.equal(summary.todayUsed, 1);
  assert.equal(summary.unknownLogsInWindow, 1);
});

test("adult budget: within limits", async () => {
  const { db, calls } = fakeDb([log(DAY, 11.94), log(DAY, 11.94)]);
  const summary = await getAlcoholSummary({ db, userId: 7, date: DAY, budget: ADULT });
  assert.equal(summary.todayUsed, 2.4);
  assert.equal(summary.overDaily, false);
  assert.equal(summary.overWeekly, false);
  assert.equal(summary.dailyRemaining, 1.6);
  assert.equal(summary.unknownLogsInWindow, 0);
  assert.deepEqual(calls.map(([name]) => name), ["select", "from", "where"]);
});

test("zero budget: any drink is over", async () => {
  const { db } = fakeDb([log(DAY, 11.94)]);
  const summary = await getAlcoholSummary({ db, userId: 7, date: DAY, budget: ZERO });
  assert.equal(ZERO.weeklyMax, 0);
  assert.equal(summary.overDaily, true);
  assert.equal(summary.overWeekly, true);
  assert.equal(summary.dailyRemaining, 0);
});

test("a week of unknown logs is not reported as clear", async () => {
  const { db } = fakeDb([log(DAY, null), log("2026-11-15", undefined)]);
  const summary = await getAlcoholSummary({ db, userId: 7, date: DAY, budget: ADULT });
  assert.equal(summary.weekUsed, 0);
  assert.equal(summary.unknownLogsInWindow, 2);
});

test("a bad date throws before any query", async () => {
  const { db, calls } = fakeDb([]);
  await assert.rejects(() => getAlcoholSummary({ db, userId: 7, date: "17/11/2026", budget: ADULT }));
  assert.equal(calls.length, 0);
});
