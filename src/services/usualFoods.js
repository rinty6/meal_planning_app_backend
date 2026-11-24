// Most eaten foods open the Australian food page (2026-11-24, user decisions
// D1-D3 in claude_memory/.../MOST_EATEN_STRIP_DESIGN.html).
//
// The user's most eaten foods are old log rows (FatSecret, manual, untagged):
// they stored energy, protein, carbs and fat only, and a serving with no grams
// ("1 medium (7" to 7-7/8" long)"). Tapping one searched FatSecret live and
// showed the American "Nutrition Facts" page.
//
// Now each most eaten food carries a ready one-food plate (`usual_plate`) that
// the app opens in PlateDetail:
//   - matched to a catalogue food by name, its portion worked out from the
//     energy the user logged (105 kcal of banana = about 110 g), with the
//     catalogue's own servings beside "Your usual";
//   - or, with no confident match, exactly what the user logged: energy and
//     macros, everything else unknown (a dash), and no grams (`unitless`).
//
// Pure: no database. mostConsumedMeals.js passes the planner pool in.

import { nutrientsFor } from "./plateBuilder.js";

const STOP_WORDS = new Set(["and", "with", "style", "the", "of", "in", "on", "or", "fresh", "homemade", "plain"]);
// "Bananas" and "Banana" are one food (decision D3): plurals and case only.
export const singular = (word) => (word.length > 3 && /s$/.test(word) && !/(ss|us|is)$/.test(word) ? word.slice(0, -1) : word);

/** The words of a logged title that a catalogue name must contain. */
export const titleTokens = (title) =>
  String(title || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .split(/[^a-z]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .map(singular);

const nameTokens = (name) => new Set(String(name || "").toLowerCase().split(/[^a-z]+/).filter(Boolean).map(singular));

/** Grams of `food` that hold `kcal`, from its energy per 100 g; null when unknown. */
export const usualGrams = (kcal, food) => {
  const per100 = Number(food?.per100g?.calories_kcal);
  const energy = Number(kcal);
  return per100 > 0 && energy > 0 ? Math.round((energy / per100) * 1000) / 10 : null;
};

// A match is only trusted when the logged energy is a believable portion of it
// (a "banana" that would weigh 2 kg is the wrong banana).
export const USUAL_GRAMS = Object.freeze({ min: 15, max: 600 });
// Titles with more words than this are dishes too specific to match by name
// ("Oriental style beef and rice noodle soup (Vietnamese pho bo)").
const MAX_TOKENS = 4;
const FRUIT_VEG = /^ausnut-(16|24)\d$/;
// Words a catalogue name may add without making the food more specific
// (how it is cooked or cut, and the default animal). Any OTHER extra word
// costs EXTRA_WORD_COST: "Egg" must find a boiled egg, not "Egg, chicken,
// scotch"; "Grilled chicken" a grilled chicken, not "Chicken, nugget,
// takeaway outlet, grilled" (live check, 2026-11-24).
const GENERIC_WORDS = new Set([
  "raw", "cooked", "boiled", "baked", "roasted", "roast", "fried", "grilled", "bbq", "steamed", "poached", "stewed",
  "microwaved", "drained", "peeled", "unpeeled", "whole", "flesh", "lean", "fat", "added", "no", "not", "further",
  "defined", "or", "and", "with", "without", "commercial", "plain", "fresh", "regular", "white", "chicken",
  "cow", "d", "nfd", "piece", "pieces",
]);
const EXTRA_WORD_COST = 0.6;
// A part of the animal the title never named is a different food ("Grilled
// chicken" is not "Chicken, skin, ... grilled").
const PART_WORDS = new Set(["skin", "wing", "neck", "liver", "gizzard", "giblet", "feet", "bone", "carcass", "tail", "tongue", "heart", "kidney"]);
const PART_WORD_COST = 3;

/**
 * The catalogue food a most eaten title stands for, or null.
 * Every word of the title must be in the food's name; among those, the food
 * whose name starts with one of those words wins, then raw fruit and
 * vegetables, then the generic "not further defined" entry, then the shortest.
 */
export const matchCatalogFood = (item, foods = []) => {
  const tokens = titleTokens(item?.title);
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return null;
  let best = null;
  for (const food of foods) {
    const words = nameTokens(food?.name);
    if (!tokens.every((t) => words.has(t))) continue;
    const grams = usualGrams(item?.calories, food);
    if (!grams || grams < USUAL_GRAMS.min || grams > USUAL_GRAMS.max) continue;
    const name = String(food.name);
    // The name's first part ("Fried rice", "Banana") made only of title words.
    const headWords = name.split(",")[0].toLowerCase().split(/[^a-z]+/).filter(Boolean).map(singular);
    let score = 0;
    if (headWords.length > 0 && headWords.every((w) => tokens.includes(w))) score += 2;
    if (FRUIT_VEG.test(food.group || "") && /\braw\b/i.test(name)) score += 1;
    if (/not further defined/i.test(name)) score += 1.5;
    const extras = [...words].filter((w) => !tokens.includes(w) && !GENERIC_WORDS.has(w) && w.length > 1);
    score -= extras.length * EXTRA_WORD_COST;
    score -= extras.filter((w) => PART_WORDS.has(w)).length * PART_WORD_COST;
    score -= name.length / 1000;
    if (!best || score > best.score) best = { food, grams, score };
  }
  return best;
};

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);

/**
 * A most eaten item -> a one-food plate for PlateDetail (`kind: "usual_food"`).
 * @param {object} item   a most eaten aggregate (mostConsumedMeals.js)
 * @param {{ food: object, grams: number } | null} match  from matchCatalogFood
 */
export const usualPlateFor = (item, match) => {
  const title = String(item?.title || "Food");
  const kcal = Number(item?.calories) || 0;
  let food;
  if (match) {
    const { food: f, grams } = match;
    const usual = { description: "Your usual", grams, isDefault: true };
    food = {
      id: f.publicId,
      food_id: f.publicId,
      externalId: f.publicId,
      source: "catalog",
      unitless: false,
      food_name: f.name,
      grams,
      per100g: f.per100g,
      servings: [usual, ...(f.servings || []).filter((s) => s.grams !== grams).map((s) => ({ ...s, isDefault: false }))],
      nutrients: nutrientsFor(f, grams),
      fallbackImage: f.image || "",
    };
  } else {
    // What the user logged, per that one logged portion. Unknown is null,
    // never zero; "unitless" because the portion has no grams.
    const per100g = {
      calories_kcal: kcal,
      energy_kj: Math.round(kcal * 4.184 * 10) / 10,
      protein_g: Number(item?.protein) || 0,
      carbohydrate_g: Number(item?.carbs) || 0,
      fat_g: Number(item?.fats) || 0,
    };
    const usual = { description: String(item?.servingDescription || "1 serve"), grams: 100, isDefault: true };
    food = {
      id: item?.externalId || "",
      food_id: item?.externalId || "",
      externalId: item?.externalId || "",
      source: item?.source || null,
      unitless: true,
      food_name: title,
      grams: 100,
      per100g,
      servings: [usual],
      nutrients: per100g,
      fallbackImage: "",
    };
  }
  const image = item?.image || food.fallbackImage;
  const { fallbackImage: _unused, ...foodItem } = food;
  return {
    type: "plate",
    kind: "usual_food",
    source: "usual_food",
    id: `usual-${titleTokens(title).join("-") || "food"}`,
    title,
    image,
    calories: Math.round(kcal),
    protein: round1(Number(item?.protein)),
    carbs: round1(Number(item?.carbs)),
    fats: round1(Number(item?.fats)),
    items: [{
      ...foodItem,
      title,
      image,
      role: "main",
      quantity: 1,
      serving: { description: foodItem.servings[0].description, grams: foodItem.grams },
      calories: Math.round(kcal),
    }],
  };
};
