// Coverage for task T6 (2026-11-21, m5-07): the variety counts. Throwaway
// sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { formatVariety, summariseVariety } from "./varietyStats.js";

const f = (id) => ({ food_id: id, food_name: id.toUpperCase() });
const card = (main, ...sides) => ({ items: [f(main), ...sides.map(f)] });

// 3 days of dinner. "salmon" is repeated on day 2 and day 3; "rice" as a side
// on every day; two cards on the same day with "beef" are NOT a repeat.
const DAYS = [
  { dinner: [card("salmon", "rice", "beans"), card("beef", "rice"), card("beef", "potato")] },
  { dinner: [card("salmon", "rice"), card("tofu", "noodles")] },
  { dinner: [card("salmon", "rice"), card("chicken", "beans")], snack: [card("apple")] },
];

test("a known repeat: mains that were on an earlier day", () => {
  const { dinner } = summariseVariety(DAYS);
  assert.equal(dinner.cards, 7);
  // day 1: 0 of 3; day 2: salmon (1 of 2); day 3: salmon (1 of 2) -> 2 of 7
  assert.equal(dinner.mains.repeatShare, 0.29);
  assert.equal(dinner.mains.distinct, 4);
  assert.deepEqual(dinner.mains.top, [
    { name: "SALMON", count: 3 },
    { name: "BEEF", count: 2 },
    { name: "CHICKEN", count: 1 },
    { name: "TOFU", count: 1 },
  ]);
});

test("sides count each use; rice and beans repeat", () => {
  const { dinner } = summariseVariety(DAYS);
  // uses: day 1 rice, beans, rice, potato (0 repeats); day 2 rice (repeat),
  // noodles; day 3 rice (repeat), beans (repeat) -> 3 of 8
  assert.equal(dinner.sides.uses, 8);
  assert.equal(dinner.sides.repeatShare, 0.38);
  assert.equal(dinner.sides.distinct, 4);
  assert.deepEqual(dinner.sides.top[0], { name: "RICE", count: 4 });
});

test("a meal seen on only one day has no repeats, and an empty week gives nothing", () => {
  const { snack } = summariseVariety(DAYS);
  assert.equal(snack.cards, 1);
  assert.equal(snack.mains.repeatShare, 0);
  assert.equal(snack.sides.uses, 0);
  assert.deepEqual(summariseVariety([]), {});
});

test("at most 5 top foods", () => {
  const day = { lunch: ["a", "b", "c", "d", "e", "f", "g"].map((m) => card(m)) };
  assert.equal(summariseVariety([day, day]).lunch.mains.top.length, 5);
  assert.equal(summariseVariety([day, day]).lunch.mains.repeatShare, 0.5);
});

test("the table prints one row per meal", () => {
  const text = formatVariety("test", summariseVariety(DAYS));
  assert.match(text, /^== test/);
  assert.match(text, /dinner\s+7\s+29%\s+4\s+38%\s+4/);
  assert.match(text, /dinner top mains: SALMON x3; BEEF x2/);
});
