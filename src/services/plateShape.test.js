// Coverage for task P2 (2026-11-20): plate shape. Whole dishes stand alone,
// sides go with the main. Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { buildPlates, primaryGroup } from "./plateBuilder.js";
import { fitsSlot, isWholeDish, shapeFor, slotsFor } from "./plateShape.js";

let nextId = 1;
const food = ({ name, group, kcal, serves = {}, grams = 150, description }) => ({
  id: nextId++,
  publicId: `food_${nextId}`,
  name,
  shortName: name.split(",")[0],
  group,
  image: null,
  defaultGrams: grams,
  per100g: { calories_kcal: kcal, energy_kj: kcal * 4.184, protein_g: 5 },
  serves100g: { grain: 0, vegetable: 0, fruit: 0, dairy: 0, protein: 0, ...serves },
  servings: [{ description: description || `1 serve (${grams} g)`, grams, isDefault: true }],
  verdicts: {},
});

// ---- shapeFor -----------------------------------------------------------------

test("shapes from the brief's examples", () => {
  assert.equal(shapeFor({ name: "Hamburger, beef patty & salad, homemade", group: "ausnut-135" }, "lunch"), "whole");
  assert.equal(shapeFor({ name: "Sandwich or roll, chicken & salad", group: "ausnut-135" }, "lunch"), "whole");
  assert.equal(shapeFor({ name: "Curry, chicken with rice or noodles", group: "ausnut-187" }, "dinner"), "whole");
  assert.equal(shapeFor({ name: "Curry, homemade, beef", group: "ausnut-187" }, "dinner"), "needs_starch");
  assert.equal(shapeFor({ name: "Beef, steak, grilled", group: "ausnut-181" }, "dinner"), "meat_and_veg");
  assert.equal(shapeFor({ name: "Breakfast cereal, whole wheat, biscuit", group: "ausnut-125" }, "breakfast"), "cereal");
  assert.equal(shapeFor({ name: "Soup, broth with meat & noodles", group: "ausnut-211" }, "lunch"), "whole");
});

test("more shapes: salads with protein, toast, eggs, eggs benedict", () => {
  assert.equal(shapeFor({ name: "Salad, chicken caesar", group: "ausnut-249" }, "lunch"), "whole");
  // Live review, 2026-11-20: a vegetable dish without meat is a side, not a main.
  assert.equal(shapeFor({ name: "Salad, caesar", group: "ausnut-249" }, "lunch"), null);
  assert.equal(shapeFor({ name: "Bread, wholemeal, toasted", group: "ausnut-122" }, "breakfast"), "toast");
  assert.equal(shapeFor({ name: "Pancake, plain", group: "ausnut-136" }, "breakfast"), "toast");
  assert.equal(shapeFor({ name: "Egg, chicken, scrambled", group: "ausnut-172" }, "breakfast"), "eggs");
  assert.equal(shapeFor({ name: "Egg, chicken, scrambled", group: "ausnut-172" }, "dinner"), "meat_and_veg");
  assert.equal(shapeFor({ name: "Eggs benedict, with bread or English muffin", group: "ausnut-172" }, "breakfast"), "whole");
  assert.equal(shapeFor({ name: "Yoghurt, natural", group: "ausnut-192" }, "breakfast"), "cereal");
});

test("a plain bread roll or tortilla is not a whole dish; stewed fruit is not a stew", () => {
  assert.equal(shapeFor({ name: "Bread, roll, white", group: "ausnut-122" }, "breakfast"), "toast");
  assert.equal(shapeFor({ name: "Wrap, white", group: "ausnut-123" }, "breakfast"), "toast");
  assert.notEqual(shapeFor({ name: "Apple, stewed, no added sugar", group: "ausnut-169" }, "breakfast"), "needs_starch");
});

test("yoghurt as a cereal main needs no extra dairy", () => {
  const slots = slotsFor("cereal", { group: "ausnut-192" }, "breakfast");
  assert.ok(slots.every((s) => !s.required));
});

// ---- live review fixes, 2026-11-20 ------------------------------------------------

test("porridge already made with milk needs no extra dairy; porridge with water does", () => {
  const withMilk = slotsFor("cereal", { name: "Porridge, rolled oats, made with cow's milk", group: "ausnut-126" }, "breakfast");
  assert.ok(withMilk.every((s) => !s.required));
  const alt = slotsFor("cereal", { name: "Porridge, rolled oats, made with dairy milk alternative", group: "ausnut-126" }, "breakfast");
  assert.ok(alt.every((s) => !s.required));
  const water = slotsFor("cereal", { name: "Porridge, rolled oats, made with water", group: "ausnut-126" }, "breakfast");
  assert.ok(water.some((s) => s.required && s.name === "dairy"));
});

test("vegetable dishes are not mains, except salads with meat and curries", () => {
  assert.equal(shapeFor({ name: "Mushroom, stuffed", group: "ausnut-249" }, "dinner"), null);
  assert.equal(shapeFor({ name: "Fritter, zucchini, fried", group: "ausnut-249" }, "lunch"), null);
  assert.equal(shapeFor({ name: "Salad, thai beef, made with lettuce", group: "ausnut-249" }, "dinner"), "whole");
  assert.equal(shapeFor({ name: "Curry, vegetable, homemade", group: "ausnut-249" }, "dinner"), "needs_starch");
});

test("a whole dish or a salad with meat never fills a side slot", () => {
  const green = slotsFor("meat_and_veg", { group: "ausnut-181" }, "dinner").find((s) => s.name === "green");
  assert.equal(fitsSlot({ name: "Poke bowl, with fish, vegetables & grains", group: "ausnut-249" }, green), false);
  assert.equal(fitsSlot({ name: "Salad, Asian style, made with cabbage, peanuts & poached chicken", group: "ausnut-249" }, green), false);
  assert.equal(fitsSlot({ name: "Salad, garden, added bacon, no added dressing", group: "ausnut-249" }, green), false);
  assert.equal(fitsSlot({ name: "Salad, garden, no added dressing", group: "ausnut-249" }, green), true);
  assert.equal(fitsSlot({ name: "Broccoli, boiled", group: "ausnut-242" }, green), true);
  assert.equal(isWholeDish({ name: "Sandwich or roll, ham & salad", group: "ausnut-135" }), true);
  assert.equal(isWholeDish({ name: "Bread, roll, white", group: "ausnut-122" }), false);
});

// ---- plates ---------------------------------------------------------------------

const burger = (n) => food({ name: `Hamburger ${n}, beef patty & salad`, group: "ausnut-135", kcal: 250, serves: { grain: 1, protein: 1 }, grams: 250 });
const steak = (n) => food({ name: `Beef ${n}, steak, grilled`, group: ["ausnut-181", "ausnut-183", "ausnut-151", "ausnut-206"][n % 4], kcal: 200, serves: { protein: 1.5 } });
const strawberry = (n) => food({ name: `Strawberry ${n}, raw`, group: "ausnut-162", kcal: 30, serves: { fruit: 1 } });
const broccoli = (n) => food({ name: `Broccoli ${n}, steamed`, group: "ausnut-242", kcal: 35, serves: { vegetable: 1.3 } });
const potato = (n) => food({ name: `Potato ${n}, boiled`, group: "ausnut-241", kcal: 70, serves: { vegetable: 1 }, grams: 170 });
const rice = (n) => food({ name: `Rice ${n}, cooked`, group: "ausnut-121", kcal: 140, serves: { grain: 1.3 }, grams: 170 });
const yoghurtSide = (n) => food({ name: `Yoghurt ${n}, natural`, group: "ausnut-192", kcal: 90, serves: { dairy: 1 } });
const milk = (n) => food({ name: `Milk ${n}, cow, fluid`, group: "ausnut-191", kcal: 60, serves: { dairy: 1 }, grams: 250 });
const cereal = (n) => food({ name: `Breakfast cereal ${n}, whole wheat, biscuit`, group: n % 2 ? "ausnut-125" : "ausnut-126", kcal: 350, serves: { grain: 3 }, grams: 60 });

const range = (n, make) => Array.from({ length: n }, (_, i) => make(i));

test("a burger plate never gets a fruit at dinner", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { plates } = buildPlates({
      mains: range(6, burger), sides: [...range(6, strawberry), ...range(6, broccoli), ...range(3, yoghurtSide)],
      meal: "dinner", targetKcal: 750, seed,
    });
    assert.ok(plates.length > 0);
    for (const p of plates) {
      assert.equal(p.shape, "whole");
      assert.ok(p.items.length <= 2, p.title);
      assert.ok(p.items.slice(1).every((i) => i.group === "ausnut-242"), p.title);
    }
  }
});

test("a steak plate has one starch and one green side", () => {
  const { plates } = buildPlates({
    mains: range(8, steak), sides: [...range(4, potato), ...range(4, rice), ...range(6, broccoli), ...range(4, strawberry)],
    meal: "dinner", targetKcal: 700, seed: 3,
  });
  assert.equal(plates.length, 5);
  for (const p of plates) {
    assert.equal(p.shape, "meat_and_veg");
    const sides = p.items.slice(1).map((i) => i.group);
    assert.equal(sides.length, 2, p.title);
    assert.equal(sides.filter((g) => g === "ausnut-241" || g === "ausnut-121").length, 1, p.title);
    assert.equal(sides.filter((g) => g === "ausnut-242").length, 1, p.title);
  }
});

test("a steak with no starch available is not offered", () => {
  const { plates } = buildPlates({ mains: range(4, steak), sides: range(6, broccoli), meal: "dinner", targetKcal: 700, seed: 1 });
  assert.equal(plates.length, 0);
});

test("a cereal plate has a dairy side", () => {
  const { plates } = buildPlates({
    mains: range(6, cereal), sides: [...range(4, milk), ...range(4, strawberry)],
    meal: "breakfast", targetKcal: 500, seed: 2,
  });
  assert.ok(plates.length > 0);
  for (const p of plates) {
    assert.equal(p.shape, "cereal");
    assert.ok(p.items.slice(1).some((i) => primaryGroup({ serves100g: i.serves }) === "dairy"), p.title);
  }
});

test("a burger alone is a valid plate when it fits the energy window", () => {
  const one = burger(99);
  const { plates } = buildPlates({ mains: [one], sides: [], meal: "lunch", targetKcal: 625, seed: 1 });
  assert.equal(plates.length, 1);
  assert.equal(plates[0].items.length, 1);
  assert.equal(plates[0].shape, "whole");
});

test("an egg on toast at breakfast: the topping may be a breakfast main", () => {
  const toast = food({ name: "Bread, wholemeal, toasted", group: "ausnut-122", kcal: 250, serves: { grain: 2 }, grams: 70 });
  const egg = food({ name: "Egg, chicken, poached", group: "ausnut-171", kcal: 140, serves: { protein: 1 }, grams: 100 });
  const { plates } = buildPlates({ mains: [toast, egg], sides: [toast], meal: "breakfast", targetKcal: 450, seed: 1 });
  const toastPlate = plates.find((p) => p.items[0].foodId === toast.id);
  assert.ok(toastPlate, "toast plate built");
  assert.equal(toastPlate.items[1].foodId, egg.id);
});

test("a curry's flat bread is naan, roti or pita, never a tortilla or injera", () => {
  const starch = slotsFor("needs_starch", { group: "ausnut-187" }, "dinner").find((x) => x.name === "starch");
  assert.equal(fitsSlot({ name: "Bread, flat, naan, commercial", group: "ausnut-123" }, starch), true);
  assert.equal(fitsSlot({ name: "Bread, flat, tortilla, white, commercial", group: "ausnut-123" }, starch), false);
  assert.equal(fitsSlot({ name: "Bread, flat, injera", group: "ausnut-123" }, starch), false);
  assert.equal(fitsSlot({ name: "Rice, white, boiled", group: "ausnut-121" }, starch), true);
});
