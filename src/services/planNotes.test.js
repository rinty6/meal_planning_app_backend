// Coverage for task T4 (2026-11-21, m5-06): plan notes name the constraint a
// plan cannot meet. Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { planNotes } from "./planNotes.js";

/** A plate item with only what planNotes reads. */
const card = (serves) => ({ plate: { serves: { vegetable: 0, fruit: 0, grain: 0, protein: 0, dairy: 0, ...serves } } });
const five = (serves) => Array.from({ length: 5 }, () => card(serves));
const NO_SERVES = { vegetable: 0, fruit: 0, grain: 0, protein: 0, dairy: 0 };

// An ordinary day: the best plates of the four meals cover every target.
const WOMAN = { vegetable: 5, fruit: 2, grain: 6, protein: 2.5, dairy: 2.5 };
const ordinaryPlan = () => ({
  breakfast: five({ grain: 2, fruit: 1, dairy: 1 }),
  lunch: five({ grain: 2, vegetable: 2, protein: 1 }),
  dinner: five({ grain: 2, vegetable: 3, protein: 1.5 }),
  snack: five({ fruit: 1, dairy: 1.5 }),
});

test("an ordinary day has no notes", () => {
  const notes = planNotes({
    recommendationsByMeal: ordinaryPlan(),
    shortByMeal: { breakfast: 0, lunch: 0, dinner: 0, snack: 0 },
    blocked: [],
    dailyServes: { ...WOMAN, row: "woman_19_50" },
    eatenServes: NO_SERVES,
    energyFactor: null,
    builtAllMeals: true,
  });
  assert.deepEqual(notes, []);
});

test("pregnancy: grain 8.5 with best plates reaching 7 is out of reach", () => {
  const plan = ordinaryPlan();
  plan.snack = five({ fruit: 1, dairy: 1.5, grain: 1 }); // 2 + 2 + 2 + 1 = 7 grain at best
  plan.breakfast[0] = card({ grain: 0.5 }); // a lower card does not change the best
  const notes = planNotes({
    recommendationsByMeal: plan,
    dailyServes: { ...WOMAN, grain: 8.5 },
    eatenServes: NO_SERVES,
    builtAllMeals: true,
  });
  assert.deepEqual(notes, [{ code: "serve_target_out_of_reach", group: "grain", target: 8.5, best: 7 }]);
});

test("within 90% of the target is not a note", () => {
  const notes = planNotes({
    recommendationsByMeal: ordinaryPlan(), // grain best 6
    dailyServes: { ...WOMAN, grain: 6.6 }, // 6 / 6.6 = 91%
    builtAllMeals: true,
  });
  assert.deepEqual(notes, []);
});

test("what is eaten counts, and a logged meal adds no plate to the best case", () => {
  const plan = ordinaryPlan();
  const dailyServes = { ...WOMAN, grain: 8.5 };
  // breakfast logged with 1 grain serve: 1 + lunch 2 + dinner 2 + snack 0 = 5
  const notes = planNotes({
    recommendationsByMeal: plan,
    dailyServes,
    eatenServes: { ...NO_SERVES, grain: 1 },
    loggedMeals: new Set(["breakfast"]),
    builtAllMeals: true,
  });
  assert.deepEqual(notes.find((n) => n.group === "grain"), { code: "serve_target_out_of_reach", group: "grain", target: 8.5, best: 5 });
  // breakfast eaten with 4.5 grain: 4.5 + 2 + 2 = 8.5, reached
  const reached = planNotes({
    recommendationsByMeal: plan,
    dailyServes,
    eatenServes: { ...NO_SERVES, grain: 4.5 },
    loggedMeals: ["breakfast"],
    builtAllMeals: true,
  });
  assert.ok(!reached.some((n) => n.group === "grain"));
});

test("serve notes only when every meal was built", () => {
  const notes = planNotes({
    recommendationsByMeal: { lunch: five({ grain: 1 }) },
    dailyServes: { ...WOMAN, grain: 8.5 },
    builtAllMeals: false,
  });
  assert.deepEqual(notes, []);
});

test("a group with no daily target never gets a note", () => {
  const notes = planNotes({
    recommendationsByMeal: ordinaryPlan(),
    dailyServes: { ...WOMAN, dairy: 0 },
    builtAllMeals: true,
  });
  assert.deepEqual(notes, []);
});

test("few_ideas per meal that is short", () => {
  const plan = ordinaryPlan();
  plan.snack = plan.snack.slice(0, 2);
  const notes = planNotes({ recommendationsByMeal: plan, shortByMeal: { lunch: 0, snack: 3 } });
  assert.deepEqual(notes, [{ code: "few_ideas", meal: "snack", shown: 2, wanted: 5 }]);
});

test("energyFactor 0.6 gives day_over_energy; 0.8 and null do not", () => {
  assert.deepEqual(planNotes({ energyFactor: 0.6 }), [{ code: "day_over_energy" }]);
  assert.deepEqual(planNotes({ energyFactor: 0.8 }), []);
  assert.deepEqual(planNotes({ energyFactor: null }), []);
});

test("unknown preference labels give one note, and nothing else is judged", () => {
  const notes = planNotes({
    recommendationsByMeal: { breakfast: [], lunch: [], dinner: [], snack: [] },
    shortByMeal: {},
    blocked: ["Moonbeans"],
    dailyServes: WOMAN,
    energyFactor: 0.5,
    builtAllMeals: true,
  });
  assert.deepEqual(notes, [{ code: "unknown_preference", labels: ["Moonbeans"] }]);
});

test("a day with a logged row of unknown food groups gives no serve notes (2026-11-25)", () => {
  const plan = ordinaryPlan();
  plan.snack = five({ fruit: 1, dairy: 1.5, grain: 1 });
  const notes = planNotes({
    recommendationsByMeal: plan,
    dailyServes: { ...WOMAN, grain: 8.5 },
    eatenServes: NO_SERVES,
    builtAllMeals: true,
    rowsWithoutServes: 1, // e.g. toast logged by barcode
    energyFactor: 0.6,
  });
  // The serve note is silent; the energy note still speaks.
  assert.deepEqual(notes, [{ code: "day_over_energy" }]);
});
