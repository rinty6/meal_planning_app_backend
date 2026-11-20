// The optional drink on every plate and snack (task P6, 2026-11-20).
//
// The user overrode decision D3 on 2026-11-20: drinks are kept, juice
// included ("not every time we just drink coffee or tea"). Every card can
// carry ONE optional drink, logged only when the user turns it on. The rules
// below are DRINKS_UI.html ("Which drinks, when" and "Rules"), unchanged.
//
// Drinks never change a plate: its foods are built without the drink, and a
// drink with energy is offered only when the plate leaves room for it.
import { evaluateFood, normalizeAllergens, normalizeDiets } from "./foodAttributeFilter.js";
import { mapPlannerAllergens } from "./plannerPool.js";
import { MAX_ENERGY_MISS, nutrientsFor, shuffled } from "./plateBuilder.js";

// P6, 2026-11-20: every drink is offered at 250 ml (1 ml taken as 1 g), the
// portion DRINKS_UI.html shows for each kind.
export const DRINK_ML = 250;
const PORTION_TEXT = Object.freeze({
  coffee: "1 cup (250 ml)",
  tea: "1 cup (250 ml)",
  juice: "1 small bottle (250 ml)",
  milk: "1 glass (250 ml)",
  water: "1 glass (250 ml)",
});
// P6, 2026-11-20: "a drink over 40 kcal is offered only on a plate at or below
// 95% of its energy target" (DRINKS_UI rules).
// Live review, 2026-11-20: that rule removed almost every flat white and juice,
// because most plates sit near 100% of their target; breakfast offered only
// water and tea. Now a drink with energy is offered when the plate WITH the
// drink still stays inside the planner's own window (MAX_ENERGY_MISS, ±25%).
// DRINK_ROOM_FIT is the fallback for a plate that carries no kcal/target.
export const DRINK_KCAL_FREE = 40;
export const DRINK_ROOM_FIT = 0.95;
// P6, 2026-11-20: no coffee under 18 (DRINKS_UI rules, caffeine).
export const MIN_COFFEE_AGE = 18;
export const MAX_DRINK_OPTIONS = 3;

// P6, 2026-11-20: never suggested, whatever the meal (DRINKS_UI rules): soft
// drinks, cordial, fruit drinks, sports and energy drinks, flavoured milk,
// mocha, juice with added sugar, smoothies, dry tea leaves, lemon or lime
// juice, ice, and alcohol (m0-07; the pool has none already).
// Powders, evaporated and condensed milk follow the plate rules (plannerPool, P1).
const NEVER = /soft drink|cola|cordial|fruit drink|sports|energy drink|flavoured|chocolate|mocha|added sugar|\bsweetened\b|smoothie|\bdry\b|leaves|\blemon\b|\blime\b|\bice\b|iced|milkshake|powder|alcohol|wine|beer|evaporated|condensed/i;

// What each name is. Order matters: the first match wins.
const MILK_COFFEE = /^coffee, (flat white|cappuccino|latte)/i;
const KINDS = [
  { kind: "milk_coffee", test: (n) => MILK_COFFEE.test(n) },
  { kind: "black_coffee", test: (n) => /^coffee, long black\b/i.test(n) },
  { kind: "herbal_tea", test: (n) => /^tea, herbal\b/i.test(n) },
  { kind: "tea", test: (n) => /^tea, (black|green)\b/i.test(n) },
  { kind: "juice", test: (n) => /^juice, (orange|apple)\b/i.test(n) },
  { kind: "sparkling", test: (n) => /^mineral water\b|carbonated|soda water/i.test(n) },
  { kind: "water", test: (n) => /^water, (tap|bottled)\b/i.test(n) },
];
const MILK_DRINK = (food) =>
  (food.group === "ausnut-191" && /^milk, cow\b/i.test(food.name || "")) ||
  (food.group === "ausnut-201" && /\b(soy|oat|almond|rice)\b.*\b(beverage|milk|drink)\b/i.test(food.name || ""));

/** The drink kind of a catalogue food, or null when it is never suggested. */
export const drinkKind = (food) => {
  const name = String(food?.name || "");
  if (!name || NEVER.test(name)) return null;
  if (MILK_DRINK(food)) return "milk";
  return KINDS.find((k) => k.test(name))?.kind ?? null;
};

const isDecaf = (name) => /decaf/i.test(name);
// Breakfast's flat white is "cow's or soy milk" (DRINKS_UI).
const isCowOrSoy = (name) => /cow|\bsoy\b/i.test(name);

// P6, 2026-11-20: which kinds each meal offers, in the order DRINKS_UI lists them.
export const DRINKS_BY_MEAL = Object.freeze({
  breakfast: ["milk_coffee", "tea", "juice", "milk", "water"],
  lunch: ["water", "sparkling", "juice", "milk_coffee", "black_coffee", "tea", "herbal_tea"],
  dinner: ["water", "sparkling", "herbal_tea"], // no coffee in the evening
  snack: ["tea", "herbal_tea", "milk_coffee", "water", "milk"],
});

/** "Flat white", "Soy flat white", "Decaf flat white", "Long black", "Orange juice"... */
export const drinkLabel = (food, kind = drinkKind(food)) => {
  const name = String(food?.name || "");
  const decaf = isDecaf(name) ? "Decaf " : "";
  switch (kind) {
    case "milk_coffee": {
      const milk = /\bsoy\b/i.test(name) ? "soy " : /\boat\b/i.test(name) ? "oat " : /\balmond\b/i.test(name) ? "almond " : /skim/i.test(name) ? "skim " : "";
      const text = `${decaf}${milk}flat white`;
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
    case "black_coffee": return decaf ? "Decaf long black" : "Long black";
    case "tea": return /green/i.test(name) ? "Green tea" : "Black tea";
    case "herbal_tea": return "Herbal tea";
    case "juice": return /apple/i.test(name) ? "Apple juice" : "Orange juice";
    case "sparkling": return /mineral/i.test(name) ? "Mineral water" : "Sparkling water";
    case "water": return "Water";
    case "milk": return /\bsoy\b/i.test(name) ? "Soy milk" : /\boat\b/i.test(name) ? "Oat milk" : /\balmond\b/i.test(name) ? "Almond milk" : "Milk";
    default: return food?.shortName || name;
  }
};

const portionKey = (kind) => (kind === "milk_coffee" || kind === "black_coffee" ? "coffee"
  : kind === "tea" || kind === "herbal_tea" ? "tea"
    : kind === "sparkling" ? "water" : kind);

const toOption = (food, kind) => {
  const kcalPer100 = Number(food.per100g?.calories_kcal);
  const kcal = Number.isFinite(kcalPer100) ? Math.round((kcalPer100 * DRINK_ML) / 100) : 0;
  return {
    foodId: food.id,
    publicId: food.publicId,
    name: food.name,
    shortName: drinkLabel(food, kind),
    kind,
    grams: DRINK_ML,
    serving_description: PORTION_TEXT[portionKey(kind)],
    kcal,
    nutrients: nutrientsFor(food, DRINK_ML),
    image: food.image || "",
  };
};

/**
 * Up to MAX_DRINK_OPTIONS drinks for one plate; the first is the suggestion.
 *
 * @param {object}   args
 * @param {object[]} args.drinks   plannerPool.getPlannerDrinks()
 * @param {string}   args.meal
 * @param {{ fit: number }} args.plate  a built plate (its energy fit decides drinks with energy)
 * @param {object}   [args.person] { age: number|null, isPregnant, isBreastfeeding, allergens, diets, strictness }
 *        age null or missing counts as an adult.
 * @param {() => number} args.rand  seeded random
 * @param {boolean}  [args.juiceUsed] true when another card of this meal already offers juice
 * @returns {object[]}
 */
export const drinksForPlate = ({ drinks = [], meal, plate, person = {}, rand = Math.random, juiceUsed = false } = {}) => {
  const kinds = DRINKS_BY_MEAL[meal];
  if (!kinds) return [];
  const mapped = mapPlannerAllergens(person.allergens || []);
  // Unknown labels: no drinks at all, exactly as candidatesForMeal blocks plates.
  if (normalizeAllergens(mapped).ignored.length > 0 || normalizeDiets(person.diets || []).ignored.length > 0) return [];

  const age = Number.isFinite(Number(person.age)) && person.age !== null ? Number(person.age) : null;
  const minor = age !== null && age < MIN_COFFEE_AGE;
  const caffeineLimited = !!(person.isPregnant || person.isBreastfeeding);
  const plateKcal = Number(plate?.totals?.kcal);
  const plateTarget = Number(plate?.target);
  const roomFor = (kcal) => (Number.isFinite(plateKcal) && plateTarget > 0
    ? (plateKcal + kcal) / plateTarget <= 1 + MAX_ENERGY_MISS
    : Number(plate?.fit) <= DRINK_ROOM_FIT);

  // A glass of milk is not offered beside a snack that already is one.
  const onPlate = new Set((plate?.items || []).map((i) => i.foodId));
  const byKind = new Map();
  for (const food of drinks) {
    if (onPlate.has(food.id)) continue;
    const kind = drinkKind(food);
    if (!kind || !kinds.includes(kind)) continue;
    const name = String(food.name || "");
    const coffee = kind === "milk_coffee" || kind === "black_coffee";
    if (coffee && minor) continue;
    // Pregnancy or breastfeeding: coffee at breakfast only, decaf elsewhere.
    if (coffee && caffeineLimited && meal !== "breakfast" && !isDecaf(name)) continue;
    // Live review, 2026-11-20: decaf was offered to everyone ("Decaf long
    // black" for a 30-year-old). It is only the stand-in for the rule above.
    if (coffee && !caffeineLimited && isDecaf(name)) continue;
    if (kind === "milk_coffee" && meal === "breakfast" && !isCowOrSoy(name)) continue;
    if (kind === "juice" && juiceUsed) continue;
    const option = toOption(food, kind);
    if (option.kcal > DRINK_KCAL_FREE && !roomFor(option.kcal)) continue;
    if (!evaluateFood(food.verdicts || {}, { allergens: mapped, diets: person.diets || [], strictness: person.strictness || {} }).passes) continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(option);
  }

  // One option per kind, the kinds in a seeded order, so the five cards of a
  // meal do not all suggest the same drink.
  const out = [];
  for (const kind of shuffled(kinds.filter((k) => byKind.has(k)), rand)) {
    if (out.length >= MAX_DRINK_OPTIONS) break;
    const options = byKind.get(kind);
    out.push(options[Math.floor(rand() * options.length)]);
  }
  return out;
};
