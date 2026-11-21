// Pure helpers for add_standard_drink_servings.mjs (checklist m3-05, task T7,
// 2026-11-21). No database here, so the arithmetic is tested on the Pi.
//
// 0 of 112 alcoholic foods had a standard-drink serving: "Wine, red" defaulted
// to a 250 ml can (2.74 standard drinks), so one glass could not be logged.

// T7, 2026-11-21: one Australian standard drink is 10 g of pure alcohol
// (NHMRC), whatever the drink.
export const STANDARD_DRINK_ALCOHOL_G = 10;
// T7, 2026-11-21: the description rounds to the nearest 5 ml, as the brief
// asks ("about 90 ml"); 1 g is taken as 1 ml for the words only.
export const ML_STEP = 5;
export const DESCRIPTION_PREFIX = "1 standard drink";

const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places;

/**
 * The standard-drink serving for a food whose default serving has `grams`
 * grams holding `alcoholG` grams of alcohol, or null when either is not a
 * positive number.
 *
 * @returns {{ grams: number, ml: number, description: string, defaultStandardDrinks: number } | null}
 */
export const standardDrinkServing = ({ alcoholG, grams } = {}) => {
  const alcohol = Number(alcoholG);
  const g = Number(grams);
  if (!Number.isFinite(alcohol) || alcohol <= 0 || !Number.isFinite(g) || g <= 0) return null;
  const sdGrams = round(STANDARD_DRINK_ALCOHOL_G / (alcohol / g), 1);
  const ml = Math.round(sdGrams / ML_STEP) * ML_STEP;
  return {
    grams: sdGrams,
    ml,
    description: `${DESCRIPTION_PREFIX} (about ${ml} ml)`,
    defaultStandardDrinks: round(alcohol / STANDARD_DRINK_ALCOHOL_G, 2),
  };
};

// Live review, 2026-11-21: the first dry run gave all 112 foods with any
// alcohol a new DEFAULT serving, including "Chicken, wing, marinated" (1
// standard drink = 10,000 g), risottos, stir-fries, soy sauce, fruit cake and
// de-alcoholised wine (5 litres). Only drinks get a standard-drink serving:
// the alcoholic beverage groups (291 beers, 292 wines, 293 spirits, 294 cider
// and perry, 295 other alcoholic beverages) plus eggnog (198, 4.4 g per
// 100 g). Ingredients inside those groups (cooked wine and spirits, mirin,
// bitters, pure ethanol) are not drinks either. 296 de-alcoholised drinks
// stay out on purpose.
export const DRINK_GROUPS = new Set(["ausnut-291", "ausnut-292", "ausnut-293", "ausnut-294", "ausnut-295"]);
export const NOT_A_DRINK = /\bcooked\b|\bmirin\b|\bbitters\b|\bethanol\b/i;
const ALCOHOLIC_MILK_DRINK = { group: "ausnut-198", minAlcoholPer100g: 2 };

/** Does this food get a standard-drink serving at all? */
export const isStandardDrinkCandidate = ({ group, name, alcoholG, grams } = {}) => {
  if (NOT_A_DRINK.test(String(name || ""))) return false;
  if (DRINK_GROUPS.has(group)) return true;
  const per100 = Number(grams) > 0 ? (Number(alcoholG) / Number(grams)) * 100 : 0;
  return group === ALCOHOLIC_MILK_DRINK.group && per100 >= ALCOHOLIC_MILK_DRINK.minAlcoholPer100g;
};

/** True when a serving description is already a standard drink (the script is idempotent). */
// T7, 2026-11-21: the brief's formula reads the profile as describing the
// default serving. A profile whose basis_quantity is not that serving's grams
// would make it wrong, so such a food is reported and skipped, never guessed.
export const BASIS_TOLERANCE_G = 0.01;
export const profileMatchesServing = (basisQuantity, grams) =>
  Number.isFinite(Number(basisQuantity)) && Number.isFinite(Number(grams))
  && Math.abs(Number(basisQuantity) - Number(grams)) <= BASIS_TOLERANCE_G;

export const isStandardDrinkDescription = (description) =>
  String(description ?? "").startsWith(DESCRIPTION_PREFIX);

// The nutrient columns of nutrition_profiles (src/db/food_schema.js), as
// Drizzle names them. Every one is scaled; alcoholG is then set to exactly 10.
// standardDrinks.test.js checks this list against the schema.
export const SCALED_NUTRIENTS = Object.freeze([
  "caloriesKcal", "energyKj", "proteinG", "carbohydrateG", "fatG", "saturatedFatG", "transFatG",
  "polyunsaturatedFatG", "monounsaturatedFatG", "cholesterolMg", "sodiumMg", "potassiumMg", "fiberG",
  "sugarG", "addedSugarsG", "vitaminDMcg", "calciumMg", "ironMg", "vitaminAMcg", "vitaminCMg", "alcoholG",
]);

const round4 = (v) => round(v, 4);

/**
 * The new nutrition profile row: a copy of the default serving's profile (as
 * Drizzle returns it) with every nutrient scaled by newGrams / defaultGrams
 * (the default serving's grams_equivalent), basis_quantity = newGrams and
 * alcohol_g = 10. null stays null (unknown is not zero). id and calculated_at
 * are left for the database to fill.
 *
 * calculation_method becomes 'scaled_from_per_100g', the only allowed value
 * that says "derived by scaling another profile" (the schema's CHECK).
 */
export const standardDrinkProfile = (profile, newGrams, defaultGrams) => {
  if (!profile || !(Number(defaultGrams) > 0) || !(Number(newGrams) > 0)) return null;
  const factor = Number(newGrams) / Number(defaultGrams);
  const { id: _id, calculatedAt: _calculatedAt, ...copy } = profile;
  for (const key of SCALED_NUTRIENTS) {
    const value = copy[key];
    copy[key] = typeof value === "number" && Number.isFinite(value) ? round4(value * factor) : null;
  }
  copy.alcoholG = STANDARD_DRINK_ALCOHOL_G;
  copy.basisQuantity = round4(Number(newGrams));
  copy.calculationMethod = "scaled_from_per_100g";
  return copy;
};

/** The new catalog_food_servings row (src/db/food_schema.js columns). */
export const standardDrinkServingRow = ({ foodId, nutritionProfileId, serving, sortOrder }) => ({
  foodId,
  nutritionProfileId,
  description: serving.description,
  numberOfUnits: 1,
  measurementDescription: "standard drink",
  // Ours, not a source's: like the synthesised 100 g serving, no upstream id.
  sourceRecordId: null,
  metricAmount: serving.grams,
  metricUnit: "g",
  gramsEquivalent: serving.grams,
  // The density of each drink is not known, so no exact millilitres; the
  // description says "about".
  millilitresEquivalent: null,
  isDefault: true,
  sortOrder,
});
