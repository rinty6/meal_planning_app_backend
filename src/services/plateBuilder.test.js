// Coverage for checklist m5-01 step 2: building plates.
// Small fake foods so each rule is checked on its own. Throwaway sprint test
// (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import {
  GRAMS,
  PLATES_PER_MEAL,
  bestPortion,
  buildPlates,
  isSideWorthy,
  plateTitle,
  portionsFor,
  primaryGroup,
  seededRandom,
  sidePortion,
  sumPlate,
} from "./plateBuilder.js";
import { isPlateWorthy, shortNameFor } from "./plannerPool.js";

let nextId = 1;
/** A fake pool food. kcal is per 100 g; serves is per 100 g. */
const food = ({ name, group, kcal, serves = {}, servings = [], shortName } = {}) => ({
  id: nextId++,
  publicId: `food_${nextId}`,
  name,
  shortName: shortName || name.split(",")[0],
  group,
  image: null,
  per100g: { calories_kcal: kcal, energy_kj: kcal * 4.184, protein_g: 5, vitamin_c_mg: null },
  serves100g: { grain: 0, vegetable: 0, fruit: 0, dairy: 0, protein: 0, ...serves },
  servings,
  verdicts: {},
});

// Mains rotate through four lunch/dinner main groups, because at most two
// plates may share a main's food group.
const MAIN_GROUPS = ["ausnut-151", "ausnut-183", "ausnut-181", "ausnut-206"];
const fish = (n) => food({ name: `Fish ${n}, baked`, group: MAIN_GROUPS[n % MAIN_GROUPS.length], kcal: 200, serves: { protein: 1 },
  servings: [{ description: "1 fillet (150 g)", grams: 150, isDefault: true }] });
const veg = (n) => food({ name: `Broccoli ${n}, steamed`, group: "ausnut-242", kcal: 35, serves: { vegetable: 1.3 },
  servings: [{ description: "1 cup (150 g)", grams: 150, isDefault: true }] });
const rice = (n) => food({ name: `Rice ${n}, cooked`, group: "ausnut-121", kcal: 140, serves: { grain: 1.3 },
  servings: [{ description: "1 cup (170 g)", grams: 170, isDefault: true }] });

const dinnerPool = () => {
  const mains = Array.from({ length: 8 }, (_, i) => fish(i));
  const sides = [...Array.from({ length: 6 }, (_, i) => veg(i)), ...Array.from({ length: 6 }, (_, i) => rice(i))];
  return { mains, sides };
};

// ---- helpers --------------------------------------------------------------

test("the seeded random is repeatable", () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.notEqual(seededRandom(1)(), seededRandom(2)());
});

test("primary group is the largest ADG serve", () => {
  assert.equal(primaryGroup(veg(0)), "vegetable");
  assert.equal(primaryGroup(food({ name: "Water", group: "x", kcal: 0 })), "other");
});

test("portions use the food's servings plus 100 g, in half steps, within limits", () => {
  const grams = portionsFor(fish(0), "main").map((p) => p.grams);
  assert.ok(grams.includes(150) && grams.includes(75) && grams.includes(225) && grams.includes(100));
  assert.ok(grams.every((g) => g >= GRAMS.min && g <= GRAMS.mainMax));
  assert.ok(!grams.includes(300 * 2)); // 2 x 300 never appears for a side or main
});

test("best portion lands near the wanted energy and prefers ordinary portions", () => {
  const p = bestPortion(fish(0), 300, "main"); // 150 g = 300 kcal exactly, the default serving
  assert.equal(p.grams, 150);
  assert.equal(p.quantity, 1);
});

test("a side is an ordinary portion: its default serving when that fits", () => {
  const p = sidePortion(veg(0));
  assert.equal(p.grams, 150);
  assert.equal(p.isDefault, true);
});

test("a garnish-sized default serving is not used as a side", () => {
  const leaf = food({ name: "Cabbage, raw", group: "ausnut-242", kcal: 22, serves: { vegetable: 1 },
    servings: [{ description: "1 leaf (23 g)", grams: 23, isDefault: true }] });
  const p = sidePortion(leaf);
  assert.ok(p.grams >= 60, `got ${p.grams} g`);
});

test("the leftover liquid of a can is never a side", () => {
  const juice = food({ name: "Peach, canned in pear juice, juice only", group: "ausnut-164", kcal: 42, serves: { fruit: 0.5 } });
  assert.equal(sidePortion(juice), null);
});

test("titles read like a meal", () => {
  assert.equal(plateTitle(["Salmon", "Brown rice", "Broccolini"]), "Salmon, brown rice & broccolini");
  assert.equal(plateTitle(["Fish", "Potato"]), "Fish & potato");
  assert.equal(plateTitle(["Soup"]), "Soup");
});

test("totals add up, and unknown stays unknown only when every item is unknown", () => {
  const items = [
    { kcal: 300, nutrients: { protein_g: 30, vitamin_c_mg: null, iron_mg: null }, serves: { grain: 0, vegetable: 0, fruit: 0, dairy: 0, protein: 1 } },
    { kcal: 50, nutrients: { protein_g: 3, vitamin_c_mg: 12, iron_mg: null }, serves: { grain: 0, vegetable: 1, fruit: 0, dairy: 0, protein: 0 } },
  ];
  const t = sumPlate(items);
  assert.equal(t.kcal, 350);
  assert.equal(t.nutrients.protein_g, 33);
  assert.equal(t.nutrients.vitamin_c_mg, 12);
  assert.equal(t.nutrients.iron_mg, null);
  assert.equal(t.serves.vegetable, 1);
});

// ---- whole plates ---------------------------------------------------------

test("dinner: five plates, each a main plus sides, near the target", () => {
  const { mains, sides } = dinnerPool();
  const { plates, shortBy } = buildPlates({ mains, sides, meal: "dinner", targetKcal: 700, seed: 3 });
  assert.equal(plates.length, PLATES_PER_MEAL);
  assert.equal(shortBy, 0);
  for (const plate of plates) {
    assert.equal(plate.items[0].role, "main");
    assert.ok(plate.items.length >= 2 && plate.items.length <= 3);
    assert.ok(plate.items.slice(1).every((i) => i.role === "side"));
    assert.ok(Math.abs(plate.totals.kcal - 700) / 700 < 0.2, `${plate.title} ${plate.totals.kcal}`);
  }
});

test("five plates have five different mains", () => {
  const { mains, sides } = dinnerPool();
  const { plates } = buildPlates({ mains, sides, meal: "dinner", targetKcal: 700, seed: 3 });
  assert.equal(new Set(plates.map((p) => p.items[0].foodId)).size, plates.length);
});

test("one kind of main per meal: never two pizzas", () => {
  const pizzas = Array.from({ length: 5 }, (_, i) => food({ name: `Pizza, style ${i}`, group: `ausnut-13${i}`, kcal: 250,
    serves: { grain: 1 }, servings: [{ description: "1 slice (100 g)", grams: 100, isDefault: true }] }));
  const { sides } = dinnerPool();
  const { plates } = buildPlates({ mains: [...pizzas, fish(99)], sides, meal: "dinner", targetKcal: 700, seed: 5 });
  assert.equal(plates.filter((p) => p.items[0].name.startsWith("Pizza")).length, 1);
});

test("a side's food group is not repeated on the same plate, nor the main's", () => {
  const { mains, sides } = dinnerPool();
  const { plates } = buildPlates({ mains, sides, meal: "dinner", targetKcal: 700, seed: 9 });
  for (const plate of plates) {
    const groups = plate.items.map((i) => primaryGroup({ serves100g: Object.fromEntries(Object.entries(i.serves).map(([g, v]) => [g, v])) }));
    assert.equal(new Set(groups).size, groups.length, plate.title);
  }
});

test("no side appears on more than two of the five plates", () => {
  const mains = Array.from({ length: 8 }, (_, i) => fish(i));
  const sides = [veg(0), rice(0), veg(1), rice(1), veg(2), rice(2)];
  const { plates } = buildPlates({ mains, sides, meal: "dinner", targetKcal: 700, seed: 1 });
  const counts = new Map();
  for (const p of plates) for (const i of p.items.slice(1)) counts.set(i.foodId, (counts.get(i.foodId) || 0) + 1);
  assert.ok([...counts.values()].every((n) => n <= 2));
});

test("the same seed gives the same plates; a new seed (Shuffle) can give others", () => {
  const { mains, sides } = dinnerPool();
  const a = buildPlates({ mains, sides, meal: "dinner", targetKcal: 700, seed: 4 }).plates.map((p) => p.id);
  const b = buildPlates({ mains, sides, meal: "dinner", targetKcal: 700, seed: 4 }).plates.map((p) => p.id);
  assert.deepEqual(a, b);
});

test("excluded foods are never used", () => {
  const { mains, sides } = dinnerPool();
  const banned = new Set([mains[0].id, sides[0].id]);
  const { plates } = buildPlates({ mains, sides, meal: "dinner", targetKcal: 700, seed: 2, excludeFoodIds: banned });
  assert.ok(plates.every((p) => p.items.every((i) => !banned.has(i.foodId))));
});

test("items carry what the app needs to edit a portion without the server", () => {
  const { mains, sides } = dinnerPool();
  const [plate] = buildPlates({ mains, sides, meal: "dinner", targetKcal: 700, seed: 2 }).plates;
  const item = plate.items[0];
  assert.ok(item.per100g && Array.isArray(item.servings) && item.serving && item.grams > 0);
  assert.equal(item.nutrients.vitamin_c_mg, null); // unknown stays unknown
});

test("too few candidates: fewer plates, and the shortfall is reported", () => {
  const { plates, shortBy } = buildPlates({ mains: [fish(1), fish(2)], sides: [veg(1), rice(1)], meal: "dinner", targetKcal: 700 });
  assert.equal(plates.length, 2);
  assert.equal(shortBy, PLATES_PER_MEAL - 2);
});

test("a plate more than 25% from its target is not offered", () => {
  const yoghurt = food({ name: "Yoghurt, natural", group: "ausnut-192", kcal: 90, serves: { dairy: 1 },
    servings: [{ description: "1 tub (150 g)", grams: 150, isDefault: true }] });
  const { plates, shortBy } = buildPlates({ mains: [yoghurt], sides: [veg(5), rice(5)], meal: "breakfast", targetKcal: 900 });
  assert.equal(plates.length, 0);
  assert.equal(shortBy, PLATES_PER_MEAL);
});

test("no target, no plates", () => {
  const { mains, sides } = dinnerPool();
  assert.equal(buildPlates({ mains, sides, meal: "dinner", targetKcal: 0 }).plates.length, 0);
});

// ---- pool hygiene found while building real plates ------------------------

test("herbs, powders, wrappers and uncooked dry legumes never go on a plate", () => {
  assert.equal(isPlateWorthy({ name: "Thyme, fresh, raw", subgroup_code: "ausnut-248" }), false);
  assert.equal(isPlateWorthy({ name: "Soy beverage, powder", subgroup_code: "ausnut-201" }), false);
  assert.equal(isPlateWorthy({ name: "Rice paper wrapper", subgroup_code: "ausnut-121" }), false);
  assert.equal(isPlateWorthy({ name: "Lentil, dried", subgroup_code: "ausnut-251" }), false);
  assert.equal(isPlateWorthy({ name: "Pea, split, dried, boiled, drained", subgroup_code: "ausnut-251" }), true);
  assert.equal(isPlateWorthy({ name: "Fig, dried", subgroup_code: "ausnut-168" }), true); // dried fruit is a real snack
  assert.equal(isPlateWorthy({ name: "Breadcrumbs, for coating food", subgroup_code: "ausnut-122" }), false);
  assert.equal(isPlateWorthy({ name: "Lemon peel, raw", subgroup_code: "ausnut-163" }), false);
});

test("onions and other aromatics are never a side, raw or cooked", () => {
  assert.equal(isSideWorthy({ name: "Onion, mature, raw", group: "ausnut-248" }), false);
  assert.equal(isSideWorthy({ name: "Onion, mature, cooked", group: "ausnut-248" }), false);
  assert.equal(isSideWorthy({ name: "Leek, cooked", group: "ausnut-248" }), false);
  assert.equal(isSideWorthy({ name: "Shallot, raw", group: "ausnut-248" }), false);
});

test("a raw vegetable is a side only if people normally eat it raw", () => {
  assert.equal(isSideWorthy({ name: "Lettuce, cos, raw", group: "ausnut-244" }), true);
  assert.equal(isSideWorthy({ name: "Tomato, roma, raw", group: "ausnut-246" }), true);
  assert.equal(isSideWorthy({ name: "Carrot, raw", group: "ausnut-243" }), true);
  assert.equal(isSideWorthy({ name: "Potato, peeled, raw", group: "ausnut-241" }), false);
  assert.equal(isSideWorthy({ name: "Turnip, white, raw", group: "ausnut-243" }), false);
  assert.equal(isSideWorthy({ name: "Pumpkin, peeled, raw", group: "ausnut-247" }), false);
  // the cooked form stays
  assert.equal(isSideWorthy({ name: "Turnip, white, boiled", group: "ausnut-243" }), true);
  // fruit is not a vegetable group: raw fruit is always fine
  assert.equal(isSideWorthy({ name: "Apple, red skin, raw", group: "ausnut-161" }), true);
});

test("an onion in the candidates never reaches a plate", () => {
  const onion = food({ name: "Onion, mature, raw", group: "ausnut-248", kcal: 40, serves: { vegetable: 1.3 },
    servings: [{ description: "1 onion, large (164 g)", grams: 164, isDefault: true }] });
  const { plates } = buildPlates({ mains: Array.from({ length: 6 }, (_, i) => fish(i)), sides: [onion, veg(8), rice(8), rice(9)], meal: "lunch", targetKcal: 650, seed: 2 });
  assert.ok(plates.length > 0);
  assert.ok(plates.every((p) => p.items.every((i) => !i.name.startsWith("Onion"))));
});

test("a side is never the same kind of food as the main or the other side", () => {
  const caesar = food({ name: "Salad, caesar", group: "ausnut-249", kcal: 180, serves: { vegetable: 1 },
    servings: [{ description: "1 bowl (290 g)", grams: 290, isDefault: true }] });
  const chickenCaesar = food({ name: "Salad, chicken caesar", group: "ausnut-249", kcal: 170, serves: { vegetable: 0.4, protein: 0.6 },
    servings: [{ description: "1 bowl (110 g)", grams: 110, isDefault: true }] });
  const { plates } = buildPlates({ mains: [caesar], sides: [chickenCaesar, rice(7), veg(7)], meal: "lunch", targetKcal: 700, seed: 1 });
  for (const p of plates) {
    const kinds = p.items.map((i) => i.name.split(",")[0].toLowerCase());
    assert.equal(new Set(kinds).size, kinds.length, p.title);
  }
});

test("cuts and styles read after the food", () => {
  assert.equal(shortNameFor({ name: "Chicken, breast, coated", baseName: "chicken", nameSegments: ["breast", "coated"] }), "Chicken breast");
  assert.equal(shortNameFor({ name: "Pork, schnitzel", baseName: "pork", nameSegments: ["schnitzel"] }), "Pork schnitzel");
});

test("short names: watermelon, eggs and tofu", () => {
  assert.equal(shortNameFor({ name: "Melon, watermelon, raw", baseName: "melon", nameSegments: ["watermelon", "raw"] }), "Watermelon");
  assert.equal(shortNameFor({ name: "Egg, chicken, scrambled", baseName: "egg", nameSegments: ["chicken", "scrambled"] }), "Egg");
  assert.equal(shortNameFor({ name: "Tofu (soy bean curd), skin", baseName: "tofu (soy bean curd)", nameSegments: ["skin"] }), "Tofu");
});
