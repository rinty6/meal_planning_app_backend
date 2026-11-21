// Coverage for task T7 (2026-11-21, m3-05): the standard-drink arithmetic.
// No database. Throwaway sprint test (checklist m7-06).
import test from "node:test";
import assert from "node:assert/strict";
import { getTableColumns } from "drizzle-orm";

import { catalogFoodServingsTable, nutritionProfilesTable } from "../../src/db/food_schema.js";
import {
  SCALED_NUTRIENTS,
  isStandardDrinkCandidate,
  isStandardDrinkDescription,
  profileMatchesServing,
  standardDrinkProfile,
  standardDrinkServing,
  standardDrinkServingRow,
} from "./standardDrinks.js";

test("a 330 ml beer with 11.94 g of alcohol: about 276 g", () => {
  const s = standardDrinkServing({ alcoholG: 11.94, grams: 330 });
  assert.equal(s.grams, 276.4);
  assert.equal(s.ml, 275);
  assert.equal(s.description, "1 standard drink (about 275 ml)");
  assert.equal(s.defaultStandardDrinks, 1.19);
});

test("a 250 ml red wine at 27.4 g (2.74 drinks): about 91 g, \"about 90 ml\"", () => {
  const s = standardDrinkServing({ alcoholG: 27.4, grams: 250 });
  assert.equal(s.grams, 91.2);
  assert.equal(s.description, "1 standard drink (about 90 ml)");
  assert.equal(s.defaultStandardDrinks, 2.74);
});

test("alcohol 0 or grams 0 gives null", () => {
  assert.equal(standardDrinkServing({ alcoholG: 0, grams: 250 }), null);
  assert.equal(standardDrinkServing({ alcoholG: 27.4, grams: 0 }), null);
  assert.equal(standardDrinkServing({ alcoholG: null, grams: 250 }), null);
  assert.equal(standardDrinkServing({}), null);
});

test("descriptions starting \"1 standard drink\" count as already done", () => {
  assert.equal(isStandardDrinkDescription("1 standard drink (about 90 ml)"), true);
  assert.equal(isStandardDrinkDescription("1 glass (150 ml)"), false);
  assert.equal(isStandardDrinkDescription(null), false);
});

test("a profile must describe the default serving", () => {
  assert.equal(profileMatchesServing(250, 250), true);
  assert.equal(profileMatchesServing(100, 250), false);
  assert.equal(profileMatchesServing(null, 250), false);
});

test("SCALED_NUTRIENTS is every nutrient column of nutrition_profiles", () => {
  const notNutrients = new Set(["id", "basisQuantity", "confidence"]);
  const numeric = Object.entries(getTableColumns(nutritionProfilesTable))
    .filter(([key, col]) => col.dataType === "number" && !notNutrients.has(key))
    .map(([key]) => key)
    .sort();
  assert.deepEqual([...SCALED_NUTRIENTS].sort(), numeric);
});

test("the new profile: scaled copy, alcohol exactly 10, null stays null, NOT NULL columns kept", () => {
  const wine = {
    id: 55, calculatedAt: new Date(), basisQuantity: 250, basisUnit: "g", basisState: "edible_portion",
    caloriesKcal: 200, energyKj: 837, proteinG: 0.5, carbohydrateG: 0.5, carbohydrateBasis: "available",
    fatG: 0, sugarG: null, sodiumMg: 10, alcoholG: 27.4, vitaminAConvention: "re",
    calculationMethod: "scaled_from_per_100g", confidence: null,
    sourceName: "ausnut_2023", sourceLicense: "CC BY 4.0", sourceDerivation: "analysed",
  };
  const p = standardDrinkProfile(wine, 91.2, 250);
  assert.equal(p.id, undefined);
  assert.equal(p.calculatedAt, undefined);
  assert.equal(p.basisQuantity, 91.2);
  assert.equal(p.alcoholG, 10);
  assert.equal(p.caloriesKcal, 72.96);
  assert.equal(p.sodiumMg, 3.648);
  assert.equal(p.fatG, 0);
  assert.equal(p.sugarG, null);
  assert.equal(p.transFatG, null); // absent stays unknown, never zero
  for (const key of ["basisUnit", "basisState", "carbohydrateBasis", "calculationMethod", "sourceName", "sourceLicense"]) {
    assert.ok(p[key], key);
  }
  assert.equal(p.vitaminAConvention, "re");
  assert.equal(standardDrinkProfile(wine, 91.2, 0), null);
  assert.equal(standardDrinkProfile(null, 91.2, 250), null);
});

test("the new serving row has every NOT NULL column and is the default", () => {
  const row = standardDrinkServingRow({
    foodId: 9, nutritionProfileId: 77, serving: standardDrinkServing({ alcoholG: 27.4, grams: 250 }), sortOrder: 3,
  });
  const columns = getTableColumns(catalogFoodServingsTable);
  for (const [key, col] of Object.entries(columns)) {
    if (col.notNull && !col.hasDefault && key !== "id") assert.ok(row[key] !== undefined && row[key] !== null, key);
  }
  assert.equal(row.isDefault, true);
  assert.equal(row.gramsEquivalent, 91.2);
  assert.equal(row.description, "1 standard drink (about 90 ml)");
  for (const key of Object.keys(row)) assert.ok(key in columns, key);
});

test("only drinks get a standard-drink serving (live review, 2026-11-21)", () => {
  const yes = (group, name, alcoholG = 10, grams = 100) => assert.equal(isStandardDrinkCandidate({ group, name, alcoholG, grams }), true, name);
  const no = (group, name, alcoholG = 10, grams = 100) => assert.equal(isStandardDrinkCandidate({ group, name, alcoholG, grams }), false, name);
  yes("ausnut-291", "Beer, full strength (alcohol 4-4.9% v/v)");
  yes("ausnut-292", "Wine, red");
  yes("ausnut-293", "Spirit, all types");
  yes("ausnut-294", "Cider, apple, alcoholic");
  yes("ausnut-295", "Mixed drink, ready to drink, spirit & cola soft drink");
  yes("ausnut-198", "Eggnog (egg nog), made from cow's milk, egg & sugar", 4.4, 100);
  // dishes, sauces and desserts with a trace of alcohol
  no("ausnut-183", "Chicken, wing, marinated, cooked", 0.054, 54);
  no("ausnut-135", "Risotto, plain", 0.2, 100);
  no("ausnut-231", "Sauce, soy, commercial", 1.4, 100);
  no("ausnut-133", "Cake, fruit, homemade, iced", 0.6, 100);
  // ingredients inside the drink groups, and de-alcoholised drinks
  no("ausnut-292", "Wine, red, cooked");
  no("ausnut-293", "Spirit, all types, cooked");
  no("ausnut-295", "Mirin");
  no("ausnut-295", "Bitters");
  no("ausnut-295", "Ethanol 100%");
  no("ausnut-296", "Wine, red, de-alcoholised", 0.2, 100);
  // a flavoured milk without alcohol worth a serving
  no("ausnut-198", "Milkshake, chocolate", 0.1, 100);
});
