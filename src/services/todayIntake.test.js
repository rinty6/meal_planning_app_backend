// Coverage for task P5 (2026-11-20): planning around what is logged today.
// The worked examples of SNACK_SLOT_DESIGN.html section 3, recomputed with
// the P3 dairy row (lunch 0.15, dinner 0.15, snack 0.35). Throwaway sprint
// test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { adjustTargets, indexPoolByPublicId, readTodayLogs, summariseToday, todayFingerprint } from "./todayIntake.js";
import { buildMealCalorieTargets } from "./mealSplit.js";
import { mealServeTargets } from "./mealServePattern.js";

const SLOTS = ["breakfast", "lunch", "dinner", "snack"];
const SPLIT = { breakfast: 0.25, lunch: 0.3, dinner: 0.35, snack: 0.1 };
const MEAL_KCAL = buildMealCalorieTargets(2000, { slots: SLOTS, split: SPLIT }); // 500 / 600 / 700 / 200
const WOMAN_51_70 = { vegetable: 5, fruit: 2, grain: 4, protein: 2, dairy: 4 };

// A porridge plate food: 1.2 dairy serves in a 300 kcal bowl.
const porridge = {
  publicId: "food_porridge", per100g: { calories_kcal: 100 },
  serves100g: { grain: 0.5, vegetable: 0, fruit: 0, dairy: 0.4, protein: 0 },
};
const POOL = indexPoolByPublicId([porridge]);

const fakeDb = (rows) => {
  const calls = [];
  const chain = {
    select: (fields) => (calls.push(["select", fields]), chain),
    from: (table) => (calls.push(["from", table]), chain),
    where: (condition) => (calls.push(["where", condition]), Promise.resolve(rows)),
  };
  return { db: chain, calls };
};

const plan = (logs) => {
  const eaten = summariseToday(logs, POOL);
  return adjustTargets({ mealKcal: MEAL_KCAL, dailyServes: WOMAN_51_70, eaten, loggedMeals: eaten.loggedMeals, dailyKcal: 2000 });
};

test("nothing logged gives the normal targets unchanged", () => {
  const out = plan([]);
  assert.deepEqual(out.kcalByMeal, MEAL_KCAL);
  assert.deepEqual(out.serveTargetsByMeal, mealServeTargets(WOMAN_51_70, { slots: SLOTS }));
  assert.deepEqual(out.adjustedMeals, []);
});

test("porridge from a plate (1.2 dairy) gives lunch/dinner/snack dairy 0.65/0.65/1.51", () => {
  const out = plan([{ mealType: "breakfast", calories: 300, externalId: "food_porridge", source: "catalog" }]);
  assert.equal(out.serveTargetsByMeal.lunch.dairy, 0.65);
  assert.equal(out.serveTargetsByMeal.dinner.dairy, 0.65);
  assert.equal(out.serveTargetsByMeal.snack.dairy, 1.51);
  assert.deepEqual(out.adjustedMeals, ["lunch", "dinner", "snack"]);
  // the logged meal keeps its usual target
  assert.deepEqual(out.serveTargetsByMeal.breakfast, mealServeTargets(WOMAN_51_70, { slots: SLOTS }).breakfast);
  assert.equal(out.kcalByMeal.breakfast, 500);
});

test("a barcode breakfast (0 serves known) gives 0.92/0.92/2.15", () => {
  const out = plan([{ mealType: "breakfast", calories: 300, externalId: "9300000000000", source: "barcode" }]);
  assert.equal(out.serveTargetsByMeal.lunch.dairy, 0.92);
  assert.equal(out.serveTargetsByMeal.dinner.dairy, 0.92);
  assert.equal(out.serveTargetsByMeal.snack.dairy, 2.15);
});

test("energy for a 2,000 kcal day: 480/560/160 after an 800 kcal breakfast", () => {
  const out = plan([{ mealType: "breakfast", calories: 800, externalId: null, source: "barcode" }]);
  assert.equal(out.kcalByMeal.lunch, 480);
  assert.equal(out.kcalByMeal.dinner, 560);
  assert.equal(out.kcalByMeal.snack, 160);
});

test("the same after 1,100 kcal, because of the 80% floor", () => {
  const out = plan([{ mealType: "breakfast", calories: 1100, externalId: null, source: "barcode" }]);
  assert.equal(out.kcalByMeal.lunch, 480);
  assert.equal(out.kcalByMeal.dinner, 560);
  assert.equal(out.kcalByMeal.snack, 160);
});

test("a small breakfast raises the other meals at most 20%", () => {
  const out = plan([{ mealType: "breakfast", calories: 50, externalId: null, source: "manual" }]);
  assert.equal(out.kcalByMeal.lunch, 720);
  assert.equal(out.kcalByMeal.dinner, 840);
  assert.equal(out.kcalByMeal.snack, 240);
});

test("a FatSecret row adds energy and no serves", () => {
  const today = summariseToday([{ mealType: "lunch", calories: 450, externalId: "12345", source: "fatsecret" }], POOL);
  assert.equal(today.eatenKcal, 450);
  assert.deepEqual(today.eatenServes, { vegetable: 0, fruit: 0, grain: 0, protein: 0, dairy: 0 });
  assert.deepEqual([...today.loggedMeals], ["lunch"]);
});

test("a catalogue row whose food left the pool adds energy and no serves", () => {
  const today = summariseToday([{ mealType: "lunch", calories: 200, externalId: "food_gone", source: "catalog" }], POOL);
  assert.equal(today.eatenKcal, 200);
  assert.equal(today.eatenServes.dairy, 0);
});

test("the fingerprint changes when a row is added or resized", () => {
  const a = todayFingerprint([{ calories: 300 }]);
  assert.equal(a, "1:300");
  assert.notEqual(todayFingerprint([{ calories: 300 }, { calories: 90 }]), a);
  assert.notEqual(todayFingerprint([{ calories: 450 }]), a);
});

test("every meal logged: nothing is adjusted", () => {
  const logs = SLOTS.map((m) => ({ mealType: m, calories: 400, externalId: null, source: "manual" }));
  const out = plan(logs);
  assert.deepEqual(out.adjustedMeals, []);
  assert.deepEqual(out.kcalByMeal, MEAL_KCAL);
});

test("today's logs are one query", async () => {
  const rows = [{ mealType: "breakfast", calories: 300, externalId: "food_porridge", source: "catalog" }];
  const { db, calls } = fakeDb(rows);
  const out = await readTodayLogs({ db, userId: 7, dateStr: "2026-11-20" });
  assert.deepEqual(out, rows);
  assert.deepEqual(calls.map(([name]) => name), ["select", "from", "where"]);
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ["calories", "externalId", "mealType", "source"]);
});
