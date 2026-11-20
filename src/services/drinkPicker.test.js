// Coverage for task P6 (2026-11-20): the optional drink on every plate, per
// DRINKS_UI.html. Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";

import { DRINK_KCAL_FREE, drinkKind, drinkLabel, drinksForPlate } from "./drinkPicker.js";
import { buildCatalogRecommendations, plateToItem } from "./catalogPlates.js";
import { seededRandom } from "./plateBuilder.js";

let nextId = 1;
const MILK_FREE = { milk: 0, soy: 0, lactose: 0 };
/** kcal per 100 ml; verdicts default to "free of milk and soy". */
const drink = (name, group, kcal, verdicts = MILK_FREE) => ({
  id: nextId++,
  publicId: `drink_${nextId}`,
  name,
  shortName: name.split(",")[0],
  group,
  image: null,
  per100g: { calories_kcal: kcal, energy_kj: kcal * 4.184, protein_g: kcal > 10 ? 3 : 0 },
  serves100g: { grain: 0, vegetable: 0, fruit: 0, dairy: 0, protein: 0 },
  servings: [{ description: "100 g", grams: 100, isDefault: true }],
  verdicts,
});

const WITH_MILK = { milk: 1, soy: 0, lactose: 1 };
const DRINKS = [
  drink("Coffee, flat white/cappuccino/latte, single shot & regular fat cow's milk", "ausnut-112", 47, WITH_MILK),
  drink("Coffee, flat white/cappuccino/latte, single shot & soy milk", "ausnut-112", 40, { milk: 0, soy: 1, lactose: 0 }),
  drink("Coffee, flat white/cappuccino/latte, decaffeinated, single shot & regular fat cow's milk", "ausnut-112", 47, WITH_MILK),
  drink("Coffee, long black, single shot", "ausnut-112", 1),
  drink("Coffee, long black, decaffeinated, single shot", "ausnut-112", 1),
  drink("Coffee, espresso", "ausnut-112", 2),
  drink("Coffee, mocha, with cow's milk", "ausnut-112", 70, WITH_MILK),
  drink("Tea, black", "ausnut-111", 0.4),
  drink("Tea, green", "ausnut-111", 0.4),
  drink("Tea, herbal", "ausnut-111", 0.4),
  drink("Tea, black, dry", "ausnut-111", 300),
  drink("Juice, orange, commercial", "ausnut-113", 44),
  drink("Juice, apple, commercial", "ausnut-113", 44),
  drink("Juice, pineapple, commercial, added sugar", "ausnut-113", 55),
  drink("Juice, lemon", "ausnut-113", 25),
  drink("Water, tap", "ausnut-118", 0),
  drink("Water, bottled", "ausnut-118", 0),
  drink("Mineral water, natural", "ausnut-118", 0),
  drink("Water, bottled, carbonated or soda water", "ausnut-118", 0),
  drink("Water, ice", "ausnut-118", 0),
  drink("Milk, cow, fluid, regular fat", "ausnut-191", 64, WITH_MILK),
  drink("Milk, cow, fluid, flavoured, chocolate", "ausnut-198", 75, WITH_MILK),
];

const ROOMY = { fit: 0.9 };
const FULL = { fit: 1.05 };
const ADULT = { age: 35 };

/** Every drink offered across many seeds, so a rule is checked on all of them. */
const offered = ({ meal, plate = ROOMY, person = ADULT, juiceUsed = false }) => {
  const names = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    for (const d of drinksForPlate({ drinks: DRINKS, meal, plate, person, rand: seededRandom(seed), juiceUsed })) names.add(d.name);
  }
  return [...names];
};
const isCoffee = (name) => /^coffee/i.test(name);

test("never suggested: added sugar juice, lemon juice, dry tea, mocha, ice, flavoured milk, espresso", () => {
  const all = ["breakfast", "lunch", "dinner", "snack"].flatMap((meal) => offered({ meal }));
  for (const name of ["Juice, pineapple, commercial, added sugar", "Juice, lemon", "Tea, black, dry", "Coffee, mocha, with cow's milk",
    "Water, ice", "Milk, cow, fluid, flavoured, chocolate", "Coffee, espresso"]) {
    assert.ok(!all.includes(name), name);
  }
  assert.equal(drinkKind({ name: "Tea, black, dry", group: "ausnut-111" }), null);
});

test("no coffee at dinner", () => {
  const names = offered({ meal: "dinner" });
  assert.ok(names.length > 0);
  assert.ok(!names.some(isCoffee), names.join(" | "));
  assert.ok(names.every((n) => /water|tea, herbal/i.test(n)), names.join(" | "));
});

test("no coffee for a 16-year-old; unknown age counts as an adult", () => {
  for (const meal of ["breakfast", "lunch", "snack"]) {
    assert.ok(!offered({ meal, person: { age: 16 } }).some(isCoffee), meal);
  }
  assert.ok(offered({ meal: "breakfast", person: { age: null } }).some(isCoffee));
  assert.ok(offered({ meal: "breakfast", person: {} }).some(isCoffee));
});

// ---- live review fixes, 2026-11-20 ------------------------------------------------

test("decaf is only offered when caffeine is limited", () => {
  for (const meal of ["breakfast", "lunch", "snack"]) {
    const coffees = offered({ meal, person: ADULT }).filter(isCoffee);
    assert.ok(coffees.length > 0, meal);
    assert.ok(coffees.every((n) => !/decaf/i.test(n)), `${meal}: ${coffees.join(" | ")}`);
  }
});

test("a drink with energy is offered when the plate with the drink stays within the ±25% window", () => {
  // A breakfast plate right on its 500 kcal target: a 118 kcal flat white keeps it at 1.24.
  const onTarget = { totals: { kcal: 500 }, target: 500, fit: 1 };
  assert.ok(offered({ meal: "breakfast", plate: onTarget }).some((n) => /flat white|juice|^milk/i.test(n)));
  // A plate already at 1.2: nothing over 40 kcal fits.
  const over = { totals: { kcal: 600 }, target: 500, fit: 1.2 };
  for (let seed = 1; seed <= 20; seed++) {
    const options = drinksForPlate({ drinks: DRINKS, meal: "breakfast", plate: over, person: ADULT, rand: seededRandom(seed) });
    assert.ok(options.every((d) => d.kcal <= DRINK_KCAL_FREE), options.map((d) => d.name).join(" | "));
  }
});

test("pregnant: coffee at breakfast, decaf only at lunch and snack", () => {
  const pregnant = { age: 30, isPregnant: true };
  assert.ok(offered({ meal: "breakfast", person: pregnant }).some((n) => isCoffee(n) && !/decaf/i.test(n)));
  for (const meal of ["lunch", "snack"]) {
    const coffees = offered({ meal, person: pregnant }).filter(isCoffee);
    assert.ok(coffees.length > 0, meal);
    assert.ok(coffees.every((n) => /decaf/i.test(n)), `${meal}: ${coffees.join(" | ")}`);
  }
  const breastfeeding = offered({ meal: "lunch", person: { age: 30, isBreastfeeding: true } }).filter(isCoffee);
  assert.ok(breastfeeding.every((n) => /decaf/i.test(n)));
});

test("breakfast flat white is cow's or soy milk", () => {
  const coffees = offered({ meal: "breakfast" }).filter(isCoffee);
  assert.ok(coffees.every((n) => /cow|soy/i.test(n)), coffees.join(" | "));
});

test("a plate at 1.05 of its target gets a zero-energy first drink, and nothing over 40 kcal", () => {
  for (let seed = 1; seed <= 20; seed++) {
    for (const meal of ["breakfast", "lunch", "snack"]) {
      const options = drinksForPlate({ drinks: DRINKS, meal, plate: FULL, person: ADULT, rand: seededRandom(seed) });
      assert.ok(options.length > 0);
      assert.ok(options[0].kcal < 5, `${meal} ${options[0].name} ${options[0].kcal}`);
      assert.ok(options.every((d) => d.kcal <= DRINK_KCAL_FREE), meal);
    }
  }
  // with room, drinks with energy can be offered
  assert.ok(offered({ meal: "breakfast" }).some((n) => /flat white|juice|^milk/i.test(n)));
});

test("juice: never when another card already has it", () => {
  assert.ok(offered({ meal: "lunch" }).some((n) => /^juice/i.test(n)));
  assert.ok(!offered({ meal: "lunch", juiceUsed: true }).some((n) => /^juice/i.test(n)));
});

test("a milk allergy removes the flat white (and milk); soy flat white stays", () => {
  const names = offered({ meal: "breakfast", person: { age: 30, allergens: ["Milk"] } });
  assert.ok(!names.some((n) => /cow's milk|^milk, cow/i.test(n)), names.join(" | "));
  assert.ok(names.some((n) => /soy milk/i.test(n)));
});

test("an unrecognised allergen label gives no drinks at all", () => {
  assert.deepEqual(drinksForPlate({ drinks: DRINKS, meal: "lunch", plate: ROOMY, person: { allergens: ["Moonbeans"] }, rand: seededRandom(1) }), []);
});

test("options: at most 3, 250 ml, labelled for the card", () => {
  const options = drinksForPlate({ drinks: DRINKS, meal: "lunch", plate: ROOMY, person: ADULT, rand: seededRandom(3) });
  assert.ok(options.length >= 1 && options.length <= 3);
  assert.equal(new Set(options.map((d) => d.kind)).size, options.length);
  for (const d of options) {
    assert.equal(d.grams, 250);
    assert.match(d.serving_description, /\(250 ml\)$/);
  }
  assert.equal(drinkLabel(DRINKS[0]), "Flat white");
  assert.equal(drinkLabel(DRINKS[1]), "Soy flat white");
  assert.equal(drinkLabel(DRINKS[11]), "Orange juice");
});

// ---- through the planner bridge -----------------------------------------------

const plateFood = (name, group, kcal, serves) => ({
  id: nextId++, publicId: `food_${nextId}`, name, shortName: name.split(",")[0], group, image: null,
  per100g: { calories_kcal: kcal, energy_kj: kcal * 4.184, protein_g: 10, carbohydrate_g: 10, fat_g: 5 },
  serves100g: { grain: 0, vegetable: 0, fruit: 0, dairy: 0, protein: 0, ...serves },
  servings: [{ description: "1 serve (150 g)", grams: 150, isDefault: true }], verdicts: {},
});
const POOL = [
  ...["ausnut-151", "ausnut-183", "ausnut-181", "ausnut-206", "ausnut-152"].map((g, i) => plateFood(`Main${i}, cooked`, g, 220, { protein: 1 })),
  ...Array.from({ length: 6 }, (_, i) => plateFood(`Veg${i}, steamed`, "ausnut-242", 35, { vegetable: 1.3 })),
  ...Array.from({ length: 4 }, (_, i) => plateFood(`Grain${i}, cooked`, "ausnut-121", 140, { grain: 1.3 })),
];

test("juice is on at most one of the five cards, and drinks never change a card's calories", async () => {
  for (const seed of ["a", "b", "c", "d", "e"]) {
    const { recommendationsByMeal } = await buildCatalogRecommendations({
      db: null, userId: 1, dateStr: "2026-11-20", mealTypes: ["lunch"], mealTargets: { lunch: 600 },
      explorationSeed: seed, person: ADULT, getPool: async () => POOL, getDrinks: async () => DRINKS,
    });
    const cards = recommendationsByMeal.lunch;
    assert.ok(cards.length > 0);
    assert.ok(cards.filter((c) => c.drinks.some((d) => d.kind === "juice")).length <= 1, seed);
    for (const card of cards) {
      const foodKcal = card.items.reduce((sum, i) => sum + i.calories, 0);
      assert.ok(Math.abs(card.calories - foodKcal) <= 2, `${card.title}: ${card.calories} vs ${foodKcal}`);
      assert.ok(card.drinks.length <= 3);
      for (const d of card.drinks) assert.equal(d.source, "catalog");
    }
  }
});

test("a legacy plate without drinks gives an empty drink list", () => {
  const item = plateToItem({
    id: "p", meal: "lunch", title: "x", items: [], target: 600, fit: 1,
    totals: { kcal: 600, nutrients: {}, serves: {} }, serveTarget: null, serveCoverage: null,
  }, "lunch");
  assert.deepEqual(item.drinks, []);
});
