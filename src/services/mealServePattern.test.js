// Coverage for checklist m5-03: spreading daily serves over meals, and
// scoring plates against them. Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { MEAL_SERVE_PATTERN, mealServeTargets } from "./mealServePattern.js";
import { buildPlates, scorePlate, serveCoverage } from "./plateBuilder.js";

const WOMAN_51_70 = { vegetable: 5, fruit: 2, grain: 4, protein: 2, dairy: 4 };

test("every food group's shares add up to the whole day", () => {
  for (const [group, shares] of Object.entries(MEAL_SERVE_PATTERN)) {
    const sum = Object.values(shares).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, group);
  }
});

test("P3: lunch's fruit and dairy share sits with the snack", () => {
  assert.deepEqual({ ...MEAL_SERVE_PATTERN.fruit }, { breakfast: 0.4, lunch: 0.1, dinner: 0, snack: 0.5 });
  assert.deepEqual({ ...MEAL_SERVE_PATTERN.dairy }, { breakfast: 0.35, lunch: 0.15, dinner: 0.15, snack: 0.35 });
  const t = mealServeTargets(WOMAN_51_70); // 2 fruit, 4 dairy a day
  assert.equal(t.lunch.fruit, 0.2);
  assert.equal(t.snack.fruit, 1);
  assert.equal(t.lunch.dairy, 0.6);
  assert.equal(t.snack.dairy, 1.4);
});

test("no vegetables are asked of breakfast, and none of fruit at dinner", () => {
  const t = mealServeTargets(WOMAN_51_70);
  assert.equal(t.breakfast.vegetable, 0);
  assert.equal(t.dinner.fruit, 0);
});

test("with three meals, the snack's share is spread over them and the day still adds up", () => {
  const t = mealServeTargets(WOMAN_51_70, { slots: ["breakfast", "lunch", "dinner"] });
  for (const g of Object.keys(WOMAN_51_70)) {
    const sum = t.breakfast[g] + t.lunch[g] + t.dinner[g];
    assert.ok(Math.abs(sum - WOMAN_51_70[g]) < 0.03, `${g} ${sum}`);
  }
  assert.ok(t.breakfast.dairy > mealServeTargets(WOMAN_51_70).breakfast.dairy);
});

test("missing daily targets give zero targets, not a crash", () => {
  const t = mealServeTargets(undefined, { slots: ["lunch"] });
  assert.deepEqual(t.lunch, { vegetable: 0, fruit: 0, grain: 0, protein: 0, dairy: 0 });
});

test("coverage: serves are minimums, so going over earns nothing extra", () => {
  const target = { vegetable: 2, dairy: 1 };
  assert.equal(serveCoverage({ vegetable: 2, dairy: 1 }, target), 1);
  assert.equal(serveCoverage({ vegetable: 4, dairy: 0 }, target), 0.5);
  assert.equal(serveCoverage({ vegetable: 1, dairy: 0.5 }, target), 0.5);
  assert.equal(serveCoverage({ vegetable: 1 }, {}), null);
});

test("between two plates with the same energy, the one covering the serve target wins", () => {
  const target = { vegetable: 2, fruit: 0, grain: 1, protein: 1, dairy: 1 };
  const covering = { kcal: 700, serves: { vegetable: 2, fruit: 0, grain: 1, protein: 1, dairy: 1 } };
  const missing = { kcal: 700, serves: { vegetable: 2, fruit: 0, grain: 1, protein: 1, dairy: 0 } };
  assert.ok(scorePlate(covering, 700, "dinner", 0, 0, target) > scorePlate(missing, 700, "dinner", 0, 0, target));
});

// ---- the side choice follows what the meal still lacks ----------------------

let id = 1;
const food = (name, group, kcal, serves) => ({
  id: id++, publicId: `f${id}`, name, shortName: name.split(",")[0], group, image: null,
  per100g: { calories_kcal: kcal }, serves100g: { grain: 0, vegetable: 0, fruit: 0, dairy: 0, protein: 0, ...serves },
  servings: [{ description: "1 serve (150 g)", grams: 150, isDefault: true }], verdicts: {},
});
const MAIN_GROUPS = ["ausnut-151", "ausnut-183", "ausnut-181", "ausnut-206"];
// P2, 2026-11-20: mains are whole dishes ("burger" in the name), whose one
// optional lunch side may be a salad vegetable or a yoghurt. A plain meat main
// now always takes a starch and a green side, so it can no longer show the
// side choice following the meal's serve need.
// 2026-11-22: a burger's ordinary serving is one burger (~300 g). With the
// 150 g serving the main cap (1.5 servings) always left "room", so the
// optional side was filled whatever the meal lacked and the test lost its point.
const mains = Array.from({ length: 8 }, (_, i) => ({
  ...food(`Main${i} burger, cooked`, MAIN_GROUPS[i % 4], 220, { protein: 1 }),
  servings: [{ description: "1 burger (300 g)", grams: 300, isDefault: true }],
}));
const sides = [
  ...Array.from({ length: 5 }, (_, i) => food(`Veg${i}, steamed`, "ausnut-242", 35, { vegetable: 1.3 })),
  ...Array.from({ length: 5 }, (_, i) => food(`Rice${i}, cooked`, "ausnut-121", 140, { grain: 1.3 })),
  ...Array.from({ length: 5 }, (_, i) => food(`Yoghurt${i}, natural`, "ausnut-192", 90, { dairy: 1 })),
];
const countDairy = (serveTarget) => {
  let n = 0;
  for (let seed = 1; seed <= 10; seed++) {
    for (const p of buildPlates({ mains, sides, meal: "lunch", targetKcal: 650, seed, serveTarget }).plates) {
      if (p.items.some((i) => i.name.startsWith("Yoghurt"))) n++;
    }
  }
  return n;
};

test("a meal short of dairy gets a dairy side more often", () => {
  const noDairyNeeded = { vegetable: 2, fruit: 0, grain: 1.5, protein: 1, dairy: 0 };
  const dairyNeeded = { vegetable: 0, fruit: 0, grain: 0, protein: 1, dairy: 1.5 };
  assert.ok(countDairy(dairyNeeded) > countDairy(noDairyNeeded), `${countDairy(dairyNeeded)} vs ${countDairy(noDairyNeeded)}`);
});

test("plates report their serve target and how much they cover", () => {
  const serveTarget = { vegetable: 2, fruit: 0, grain: 1, protein: 1, dairy: 1 };
  const [plate] = buildPlates({ mains, sides, meal: "lunch", targetKcal: 650, seed: 1, serveTarget }).plates;
  assert.deepEqual(plate.serveTarget, serveTarget);
  assert.ok(plate.serveCoverage > 0 && plate.serveCoverage <= 1);
});

test("what is missing in a group none of the remaining meals carries is shared between them (2026-11-25)", () => {
  // Breakfast, lunch and dinner logged; 1.4 vegetable serves still missing; only the snack is left.
  const t = mealServeTargets({ vegetable: 1.4, fruit: 0, grain: 0, protein: 0, dairy: 0 }, { slots: ["snack"] });
  assert.equal(t.snack.vegetable, 1.4);
  // Shared equally when two such meals remain.
  const two = mealServeTargets({ vegetable: 1, fruit: 0, grain: 0, protein: 0, dairy: 0 }, { slots: ["breakfast", "snack"] });
  assert.equal(two.breakfast.vegetable, 0.5);
  assert.equal(two.snack.vegetable, 0.5);
  // A normal day is unchanged: breakfast still carries no vegetables.
  assert.equal(mealServeTargets({ vegetable: 5 }).breakfast.vegetable, 0);
});
