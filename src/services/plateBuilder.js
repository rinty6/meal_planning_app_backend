// Builds the planner's plates (checklist m5-01, step 2).
//
// A plate is one MAIN plus one or two SIDES, sized together toward the meal's
// energy target (decision D1, 2026-11-19). Pure: it takes the candidates from
// plannerPool.candidatesForMeal and returns plates. No database, no network,
// so it runs in milliseconds on the in-memory pool and is fully testable.
//
// Since P2 (2026-11-20) the main's SHAPE decides which sides it gets
// (plateShape.js): a whole dish (burger, sandwich, pizza, soup) stands alone
// or takes one side that goes with it; a curry gets a starch; meat gets a
// starch and a green vegetable; cereal gets milk or yoghurt; toast gets a
// topping; eggs get bread. Sides are still ranked by sideScore below, which
// is why PREFERRED_SIDES and SIDE_ORDER stay.
//
// How a plate is built
//   1. Choose the SIDES first, slot by slot, at ordinary portions: the food's default
//      serving where that is within the side's energy cap (SIDE_KCAL_CAP),
//      otherwise the portion nearest 80% of the cap. Sides come from food
//      groups the plate does not cover yet, preferring the meal's own side
//      groups (PREFERRED_SIDES: vegetables, potato, rice and pasta at dinner;
//      fruit, milk, yoghurt and bread at breakfast).
//   2. Then size the MAIN to fill what is left, using its own servings plus
//      100 g in half steps (the same steps every picker in the app uses).
//   3. Score: closeness to the target first; then food-group variety, a
//      vegetable at lunch and dinner, and ordinary portions; personal signals
//      only break near-ties.
//   4. Keep the best plates with a different main each, no side on more than
//      MAX_SIDE_REPEAT plates and no more than MAX_PER_MAIN_GROUP mains from
//      one food group, so five plates are five different meals.
//
// Why sides first: the first version sized the main and let the sides fill
// the gap. Energy came out perfect and the plates were absurd (two English
// muffins and a caesar salad as "sides", croutons, a 420 g can of beans),
// because the gap pulled in the most energy-dense sides. Real plates carry
// their energy in the main; sides stay ordinary.
//
// Serve targets (m5-03, 2026-11-19): when a meal's serve target is given
// (mealServePattern.js, from the user's own ADG targets), sides are drawn
// toward the groups the plate still lacks (NEED_WEIGHT) and plates earn up to
// SERVE_WEIGHT for covering it. Without one, the old food-group count is used.

import { fitsSlot, shapeFor, slotsFor } from "./plateShape.js";

export const PLATES_PER_MEAL = 5; // Q1, decided 2026-11-19
export const STEPS = Object.freeze([0.5, 1, 1.5, 2]);
export const SIDE_ORDER = Object.freeze({
  breakfast: ["fruit", "dairy", "grain"],
  lunch: ["vegetable", "fruit", "dairy", "grain"],
  dinner: ["vegetable", "grain", "protein"],
  snack: ["fruit", "dairy", "grain"],
});
export const MAX_SIDES = 2;
// A plate further than this from its meal's energy target is not offered. A
// low-energy main (yoghurt as a large breakfast) cannot reach the target at a
// sane portion, and offering it anyway would quietly under-feed the user.
// Too few plates is reported (shortBy) instead.
export const MAX_ENERGY_MISS = 0.25;
export const MAX_SIDE_REPEAT = 2;
export const MAX_PER_MAIN_GROUP = 2;
// Realistic portion limits. A side of 600 g of potato is technically a
// portion, but nobody would serve it.
export const GRAMS = Object.freeze({ min: 15, mainMax: 350, sideMax: 300 });
// Most energy one side may bring, by its food group.
export const SIDE_KCAL_CAP = Object.freeze({ vegetable: 150, fruit: 150, dairy: 220, grain: 300, protein: 250, other: 150 });
// The main must keep at least this share of the plate's energy.
const MIN_MAIN_SHARE = 0.35;
// AUSNUT sub-groups each meal's sides should come from first. Other groups
// the meal table allows are still used, but only when these run out.
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `ausnut-${from + i}`);
export const PREFERRED_SIDES = Object.freeze({
  breakfast: new Set([...range(161, 168), "ausnut-191", "ausnut-192", "ausnut-201", "ausnut-205", "ausnut-122", "ausnut-123"]),
  lunch: new Set([...range(242, 249), "ausnut-241", ...range(161, 167), "ausnut-191", "ausnut-192", "ausnut-194",
    "ausnut-201", "ausnut-203", "ausnut-122", "ausnut-123", "ausnut-132", "ausnut-251"]),
  dinner: new Set([...range(242, 249), "ausnut-241", "ausnut-121", "ausnut-124", "ausnut-251"]),
  snack: new Set([...range(161, 168), "ausnut-191", "ausnut-192", "ausnut-194", "ausnut-132"]),
});
// Added sugar in an everyday food's name: still allowed, just not preferred.
const ADDED_SUGAR = /sugar sweetened|in syrup|sweetened/i;
// The liquid left in a can, recorded as its own food: never a side.
const LIQUID_ONLY = /juice only|syrup only|liquid only|brine only/i;
// A side smaller than both of these is a garnish, not a side (1 cabbage leaf).
const SIDE_MIN = Object.freeze({ grams: 60, kcal: 60 });

// Which vegetables can be a side (iPhone test, 2026-11-19: "mature onion, 1
// large, raw" was offered at lunch). Measured on the live pool: 112 of 351
// vegetable sides were raw, including raw potato, sweet potato, cassava, taro,
// pumpkin and eggplant.
//   Never a side, in any form: aromatics and seasonings cooked INTO food.
export const NEVER_A_SIDE = new Set([
  "onion", "shallot", "spring onion", "leek", "garlic", "ginger", "chilli", "chili",
  "herbs", "wasabi", "truffles", "lemongrass",
]);
//   Raw is fine only for vegetables people normally eat raw; any other raw
//   vegetable is not a side at all (its cooked form still is).
export const RAW_IS_NORMAL = new Set([
  "lettuce", "tomato", "cucumber", "capsicum", "carrot", "celery", "spinach", "rocket",
  "cabbage", "sprout", "mushroom", "avocado", "radish", "snow pea", "sugar snap pea",
  "watercress", "chicory", "endive", "kale", "salad",
]);
const VEGETABLE_GROUPS = /^ausnut-24[1-9]$/;

/** The kind of food: the first clause of its name ("onion", "salad", "rice"). */
export const kindOf = (food) => String(food?.name || "").split(",")[0].trim().toLowerCase();

/** May this food be a side at all? (It may still be a main where the meal table allows.) */
export const isSideWorthy = (food) => {
  const kind = kindOf(food);
  if (NEVER_A_SIDE.has(kind)) return false;
  if (VEGETABLE_GROUPS.test(food?.group || "") && /\braw\b/i.test(food?.name || "") && !RAW_IS_NORMAL.has(kind)) {
    return false;
  }
  return true;
};
const MAINS_TRIED = 60; // per request; plenty to find 5 good plates
const SIDES_TRIED = 40; // per side slot per main
const SERVE_COUNTS_FROM = 0.25; // a food group "is on the plate" from 1/4 serve

const ADG_GROUPS = ["grain", "vegetable", "fruit", "dairy", "protein"];

// ---- small helpers -----------------------------------------------------------

/** Seeded PRNG (mulberry32), so a shuffle seed always gives the same plates. */
export const seededRandom = (seed = 1) => {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const shuffled = (items, rand) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/** kcal per gram; falls back to kJ when kcal is missing. */
export const kcalPerGram = (food) => {
  const kcal = food.per100g?.calories_kcal;
  if (Number.isFinite(kcal)) return kcal / 100;
  const kj = food.per100g?.energy_kj;
  return Number.isFinite(kj) ? kj / 4.184 / 100 : 0;
};

/** The food group a food mostly belongs to, by ADG serves per 100 g. */
export const primaryGroup = (food) => {
  let best = "other";
  let bestValue = 0;
  for (const g of ADG_GROUPS) {
    const v = Number(food.serves100g?.[g]) || 0;
    if (v > bestValue) {
      best = g;
      bestValue = v;
    }
  }
  return best;
};

/**
 * Every sensible portion of a food: its servings plus 100 g, times each step,
 * within the gram limits for the role. Deduplicated by grams.
 */
export const portionsFor = (food, role = "side") => {
  const max = role === "main" ? GRAMS.mainMax : GRAMS.sideMax;
  const bases = [...(food.servings || []), { description: "100 g", grams: 100, isDefault: false }];
  const seen = new Set();
  const out = [];
  for (const serving of bases) {
    for (const quantity of STEPS) {
      const grams = Math.round(serving.grams * quantity * 10) / 10;
      if (grams < GRAMS.min || grams > max) continue;
      const key = grams.toFixed(1);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ serving: { description: serving.description, grams: serving.grams }, quantity, grams, isDefault: !!serving.isDefault });
    }
  }
  return out;
};

/**
 * The portion whose energy is closest to `wantKcal`. Unusual portions (not 1
 * of a serving, not the default serving) cost a little extra, so between two
 * near-equal options the ordinary one wins.
 */
export const bestPortion = (food, wantKcal, role = "side", { maxGrams = Infinity } = {}) => {
  const perGram = kcalPerGram(food);
  if (perGram <= 0) return null;
  const slack = Math.max(wantKcal, 50) * 0.04;
  let best = null;
  for (const p of portionsFor(food, role)) {
    if (p.grams > maxGrams) continue;
    const kcal = p.grams * perGram;
    const miss = Math.abs(kcal - wantKcal);
    const unusual = (p.quantity === 1 ? 0 : 1) + (p.isDefault ? 0 : 1);
    const score = miss + unusual * slack;
    if (!best || score < best.score) best = { ...p, kcal, score };
  }
  return best;
};

const bigEnough = (grams, kcal) => grams >= SIDE_MIN.grams || kcal >= SIDE_MIN.kcal;

/**
 * An ordinary side portion: the default serving if it fits the energy cap and
 * is not a garnish; otherwise the portion nearest 80% of the cap. Null when no
 * portion is both big enough and within the cap.
 */
export const sidePortion = (food) => {
  if (LIQUID_ONLY.test(food.name || "")) return null;
  const cap = SIDE_KCAL_CAP[primaryGroup(food)] ?? SIDE_KCAL_CAP.other;
  const perGram = kcalPerGram(food);
  if (perGram <= 0) return null;
  const def = (food.servings || []).find((s) => s.isDefault);
  if (def && def.grams >= GRAMS.min && def.grams <= GRAMS.sideMax) {
    const kcal = def.grams * perGram;
    if (kcal <= cap && bigEnough(def.grams, kcal)) {
      return { serving: { description: def.description, grams: def.grams }, quantity: 1, grams: def.grams, isDefault: true, kcal };
    }
  }
  const p = bestPortion(food, cap * 0.8, "side");
  return p && p.kcal <= cap * 1.1 && bigEnough(p.grams, p.kcal) ? p : null;
};

/** Nutrient totals for a portion, from per 100 g. Unknown (null) stays null. */
export const nutrientsFor = (food, grams) => {
  const out = {};
  for (const [key, per100] of Object.entries(food.per100g || {})) {
    out[key] = per100 === null || per100 === undefined ? null : Math.round((per100 * grams) / 100 * 100) / 100;
  }
  return out;
};

export const servesFor = (food, grams) => {
  const out = {};
  for (const g of ADG_GROUPS) out[g] = Math.round(((Number(food.serves100g?.[g]) || 0) * grams) / 100 * 100) / 100;
  return out;
};

const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** "Salmon, brown rice & broccolini" */
export const plateTitle = (names) => {
  if (names.length === 0) return "";
  const [first, ...rest] = names;
  if (rest.length === 0) return first;
  const tail = rest.map(lowerFirst);
  return tail.length === 1 ? `${first} & ${tail[0]}` : `${first}, ${tail.slice(0, -1).join(", ")} & ${tail[tail.length - 1]}`;
};

// ---- one plate ------------------------------------------------------------------

/** Sums a list of plate items into totals. Null + number = number; null only if all null. */
export const sumPlate = (items) => {
  const nutrients = {};
  const serves = Object.fromEntries(ADG_GROUPS.map((g) => [g, 0]));
  for (const item of items) {
    for (const [k, v] of Object.entries(item.nutrients)) {
      if (v === null) {
        if (!(k in nutrients)) nutrients[k] = null;
      } else {
        nutrients[k] = Math.round(((nutrients[k] ?? 0) + v) * 100) / 100;
      }
    }
    for (const g of ADG_GROUPS) serves[g] = Math.round((serves[g] + item.serves[g]) * 100) / 100;
  }
  const kcal = items.reduce((sum, item) => sum + item.kcal, 0);
  return { nutrients, serves, kcal: Math.round(kcal) };
};

export const itemFor = (food, role, portion) => ({
  foodId: food.id,
  publicId: food.publicId,
  name: food.name,
  shortName: food.shortName,
  group: food.group,
  image: food.image,
  role,
  serving: portion.serving,
  quantity: portion.quantity,
  grams: portion.grams,
  kcal: Math.round(portion.kcal),
  nutrients: nutrientsFor(food, portion.grams),
  serves: servesFor(food, portion.grams),
  // Sent so the app can change the portion without asking the server.
  servings: food.servings,
  per100g: food.per100g,
});

// Serve targets (m5-03). How much covering this meal's serve target is worth,
// next to energy fit (a 10% energy miss costs 0.1): a plate covering every
// group's target earns SERVE_WEIGHT. Energy stays first because plates must
// already sit inside MAX_ENERGY_MISS before they are scored at all.
// When choosing a side, NEED_WEIGHT is what a food group the plate still lacks
// is worth (compare PREFERRED_SIDES' 0.3).
//
// Tuned on live plates, 2026-11-19, for a woman 51-70, a man 19-50 and a
// pregnant woman (20 seeds x 3 meals each):
//   0.35 / 0.3   dairy 2.1-2.4 of target, energy miss 2.4-4.2%
//   0.6  / 0.5   dairy 2.3-2.7,           energy miss 2.9-5.2%   <- chosen
//   0.9  / 0.8   dairy 2.4-2.6,           energy miss 3.9-6.4%   (no better, less accurate)
// What weights cannot fix is structural: three plates of at most two sides
// fit about one dairy side per meal, so a woman 51-70 (4 dairy serves) needs
// the snack slot (m5-04), and pregnancy's 8.5 grain serves need m5-06 to say
// plainly when a day cannot reach them.
export const SERVE_WEIGHT = 0.5;
export const NEED_WEIGHT = 0.6;

/**
 * How much of a meal's serve target a plate covers, 0..1: the mean over the
 * groups with a target of min(1, serves / target). Serves are minimums, so
 * going over a group's target earns nothing extra and costs nothing.
 * Null when there is no serve target to score against.
 */
export const serveCoverage = (serves, serveTarget) => {
  const groups = ADG_GROUPS.filter((g) => Number(serveTarget?.[g]) > 0);
  if (groups.length === 0) return null;
  const sum = groups.reduce((acc, g) => acc + Math.min(1, (Number(serves?.[g]) || 0) / Number(serveTarget[g])), 0);
  return sum / groups.length;
};

/** Higher is better. */
export const scorePlate = ({ kcal, serves }, target, meal, personal = 0, unusualPortions = 0, serveTarget = null) => {
  const fit = Math.abs(kcal - target) / target;
  const coverage = serveCoverage(serves, serveTarget);
  // Without a serve target, fall back to counting food groups (the pre-m5-03 placeholder).
  const servesTerm = coverage === null
    ? ADG_GROUPS.filter((g) => serves[g] >= SERVE_COUNTS_FROM).length * 0.05
    : coverage * SERVE_WEIGHT;
  const vegBonus = (meal === "lunch" || meal === "dinner") && serves.vegetable >= 0.5 ? 0.1 : 0;
  return -fit + servesTerm + vegBonus - unusualPortions * 0.02 + Math.min(personal, 0.05);
};

/** Share of each group's target still missing, 0..1 (0 when there is no target). */
const serveNeed = (current, serveTarget) => {
  const need = {};
  for (const g of ADG_GROUPS) {
    const t = Number(serveTarget?.[g]) || 0;
    need[g] = t > 0 ? Math.max(0, 1 - (Number(current[g]) || 0) / t) : 0;
  }
  return need;
};

/** How much a side suits this meal and this plate. Higher is better. */
const sideScore = (side, meal, rand, bonusFor, need = {}) => {
  const g = primaryGroup(side);
  const order = SIDE_ORDER[meal] || [];
  const rank = order.indexOf(g);
  const orderBonus = rank === -1 ? 0 : (order.length - rank) * 0.05;
  const preferred = PREFERRED_SIDES[meal]?.has(side.group) ? 0.3 : 0;
  const sugar = ADDED_SUGAR.test(side.name || "") ? -0.15 : 0;
  const fillsGap = (need[g] || 0) * NEED_WEIGHT;
  return preferred + orderBonus + fillsGap + sugar + Math.min(bonusFor(side), 0.02) + rand() * 0.06;
};

const addServes = (a, b) => Object.fromEntries(ADG_GROUPS.map((g) => [g, (Number(a[g]) || 0) + (Number(b[g]) || 0)]));

// P2, 2026-11-20: an optional side is added when the main would otherwise be
// above this many of its default servings (the plate has energy to spare), or
// when the plate still lacks more than OPTIONAL_NEED of the side's food group.
const OPTIONAL_ROOM_SERVINGS = 1.5;
const OPTIONAL_NEED = 0.5;

/** The main's ordinary serving in grams: pool defaultGrams, else its default serving, else 100 g. */
const mainDefaultGrams = (main) =>
  Number(main.defaultGrams) || (main.servings || []).find((s) => s.isDefault)?.grams || 100;

// iPhone test, 2026-11-22: once whole dishes and steaks took fewer sides, the
// main soaked up the rest of the meal's energy: 180 g of barley cereal (two
// cups), 350 g of Greek yoghurt, 248 g of silver perch (750 kcal) for a
// 2,991 kcal day. A main now stops at MAIN_MAX_SERVINGS of its ordinary
// serving (never below MAIN_MIN_CAP_G, so a 60 g "small fillet" default does
// not starve the plate); the optional side slots fill the rest, as they
// already do when the main would pass OPTIONAL_ROOM_SERVINGS.
export const MAIN_MAX_SERVINGS = 1.5;
// Foods whose ordinary serving is ONE PIECE ("1 slice", "1 piece", "1
// dumpling") are eaten several at a time: 1.5 slices of pizza is not a
// dinner. Their cap is at least PIECE_MIN_CAP_G (about 2-3 pizza slices or 8
// sushi pieces).
const PIECE_UNIT = /\b(slice|piece|nugget|wing|dumpling|ball|stick|finger|skewer|roll, sushi|sushi)\b/i;
const PIECE_MIN_CAP_G = 250;
// Sides grow only for a plate still this short after the capped main, up to
// SIDE_GROW_MAX of their ordinary portion, and stop once within SIDE_GROW_STOP.
const SIDE_GROW_FROM = 0.1;
const SIDE_GROW_STOP = 0.03;
const SIDE_GROW_MAX = 2;
const MAIN_MIN_CAP_G = 100;
export const mainCapGrams = (main) => {
  const def = (main.servings || []).find((s) => s.isDefault);
  const floor = PIECE_UNIT.test(String(def?.description || "")) ? PIECE_MIN_CAP_G : MAIN_MIN_CAP_G;
  return Math.max(floor, MAIN_MAX_SERVINGS * mainDefaultGrams(main));
};

const buildOne = ({ main, sides, meal, target, rand, bonusFor, serveTarget = null }) => {
  // P2, 2026-11-20: the plate follows the main's shape (plateShape.js).
  // Required slots are filled first; optional slots only when the plate has
  // room. What the plate already holds is estimated from the main at a
  // typical share of the meal (it is sized last), so sides can go where this
  // meal's serves are still short.
  const shape = shapeFor(main, meal);
  if (!shape) return null; // a vegetable dish is a side, not a main (live review, 2026-11-20)
  const slots = slotsFor(shape, main, meal);
  const mainCap = { maxGrams: mainCapGrams(main) };
  const mainEstimate = bestPortion(main, target * 0.55, "main", mainCap);
  let running = mainEstimate ? servesFor(main, mainEstimate.grams) : Object.fromEntries(ADG_GROUPS.map((g) => [g, 0]));
  const chosen = [];
  // An optional side never repeats the food group of the main or of another
  // side (no two fruits on a pancake plate); a required slot is its own role.
  const usedGroups = new Set([primaryGroup(main)]);
  const usedFoods = new Set([main.id]);
  // No caesar salad beside a caesar salad: one food of each kind per plate.
  const usedKinds = new Set([kindOf(main)]);
  const pool = shuffled(sides, rand).slice(0, SIDES_TRIED * 4);
  const perGramMain = kcalPerGram(main);
  const ordered = [...slots.filter((s) => s.required), ...slots.filter((s) => !s.required)];
  for (const s of ordered) {
    // A roomOnly slot (a big day's extra side, plateShape.js) may be a third side.
    if (chosen.length >= (s.roomOnly ? MAX_SIDES + 1 : MAX_SIDES)) break;
    const need = serveNeed(running, serveTarget);
    let room = true;
    if (!s.required) {
      const sidesKcal = chosen.reduce((sum, c) => sum + c.portion.kcal, 0);
      const mainGrams = perGramMain > 0 ? (target - sidesKcal) / perGramMain : 0;
      // 2026-11-22: "room" now means the main would pass its cap.
      room = mainGrams > Math.max(OPTIONAL_ROOM_SERVINGS * mainDefaultGrams(main), mainCapGrams(main));
    }
    if (s.roomOnly && !room) continue;
    let best = null;
    for (const side of pool) {
      if (!fitsSlot(side, s)) continue;
      if (usedFoods.has(side.id)) continue;
      if (usedKinds.has(kindOf(side))) continue;
      const g = primaryGroup(side);
      if (!s.required && !s.sameGroupOk && usedGroups.has(g)) continue;
      if (!s.required && !room && !((need[g] || 0) > OPTIONAL_NEED)) continue;
      const portion = sidePortion(side);
      if (!portion) continue;
      const score = sideScore(side, meal, rand, bonusFor, need);
      if (!best || score > best.score) best = { side, portion, g, score, required: s.required };
    }
    if (!best) {
      if (s.required) return null; // a steak with no starch is not this plate
      continue;
    }
    chosen.push(best);
    usedGroups.add(best.g);
    usedFoods.add(best.side.id);
    usedKinds.add(kindOf(best.side));
    running = addServes(running, servesFor(best.side, best.portion.grams));
  }

  // 2. The main fills what is left. If the sides leave the main too little,
  //    drop optional sides rather than shrink the main to a garnish; if the
  //    required sides alone do that, this main cannot make this plate.
  let mainPortion = null;
  for (;;) {
    const sidesKcal = chosen.reduce((sum, c) => sum + c.portion.kcal, 0);
    const want = target - sidesKcal;
    if (want >= target * MIN_MAIN_SHARE) {
      mainPortion = bestPortion(main, want, "main", mainCap);
      break;
    }
    const lastOptional = chosen.map((c) => c.required).lastIndexOf(false);
    if (lastOptional === -1) return null;
    chosen.splice(lastOptional, 1);
  }
  // A whole dish alone is a plate (decision Q1); any other main needs a side.
  if (!mainPortion || (chosen.length === 0 && shape !== "whole")) return null;

  // 3. 2026-11-22: when the main stopped at its cap and the plate is still
  //    more than SIDE_GROW_FROM short, the sides grow (up to SIDE_GROW_MAX
  //    times their ordinary portion), never the main: a big eater gets two
  //    potatoes, not 400 g of steak. Required sides (the starch) grow first.
  let deficit = target - mainPortion.kcal - chosen.reduce((sum, c) => sum + c.portion.kcal, 0);
  if (deficit > target * SIDE_GROW_FROM) {
    const order = [...chosen.filter((c) => c.required), ...chosen.filter((c) => !c.required)];
    for (const c of order) {
      if (deficit <= target * SIDE_GROW_STOP) break;
      const maxGrams = Math.min(GRAMS.sideMax, c.portion.grams * SIDE_GROW_MAX);
      const grown = bestPortion(c.side, c.portion.kcal + deficit, "side", { maxGrams });
      if (grown && grown.kcal > c.portion.kcal) {
        deficit -= grown.kcal - c.portion.kcal;
        c.portion = grown;
      }
    }
  }

  const items = [itemFor(main, "main", mainPortion), ...chosen.map((c) => itemFor(c.side, "side", c.portion))];
  const unusual = [mainPortion, ...chosen.map((c) => c.portion)]
    .filter((p) => p.quantity !== 1 || !p.isDefault).length;
  const totals = sumPlate(items);
  const personal = items.reduce((sum, item) => sum + bonusFor({ id: item.foodId }), 0);
  return {
    id: `plate_${meal}_${items.map((i) => `${i.foodId}x${i.grams}`).join("_")}`,
    meal,
    shape,
    title: plateTitle(items.map((i) => i.shortName)),
    items,
    totals,
    target: Math.round(target),
    fit: Math.round((totals.kcal / target) * 100) / 100,
    serveTarget: serveTarget || null,
    serveCoverage: serveCoverage(totals.serves, serveTarget),
    score: scorePlate(totals, target, meal, personal, unusual, serveTarget) + rand() * 0.02,
  };
};

// ---- five plates ----------------------------------------------------------------

/**
 * @param {object}   args
 * @param {object[]} args.mains      from candidatesForMeal
 * @param {object[]} args.sides      from candidatesForMeal
 * @param {string}   args.meal       "breakfast" | "lunch" | "dinner" | "snack"
 * @param {number}   args.targetKcal the meal's energy target (mealSplit.js)
 * @param {number}   [args.count]    plates wanted (default 5)
 * @param {number}   [args.seed]     same seed, same plates; Shuffle sends a new one
 * @param {(food:{id:number})=>number} [args.bonusFor] personal tie-breaker, 0..0.05
 * @param {Set<number>} [args.excludeFoodIds] foods never to use (e.g. skipped)
 * @param {object} [args.serveTarget] this meal's serves, { vegetable, fruit, grain, protein, dairy }
 *        (mealServePattern.mealServeTargets). Without it plates are scored the pre-m5-03 way.
 * @returns {{ plates: object[], shortBy: number }}
 */
export const buildPlates = ({
  mains = [],
  sides = [],
  meal,
  targetKcal,
  count = PLATES_PER_MEAL,
  seed = 1,
  bonusFor = () => 0,
  excludeFoodIds = new Set(),
  serveTarget = null,
} = {}) => {
  if (!Number.isFinite(targetKcal) || targetKcal <= 0) return { plates: [], shortBy: count };
  const rand = seededRandom(seed);
  const usableMains = mains.filter((f) => !excludeFoodIds.has(f.id));
  // P2, 2026-11-20: a slot may take a food the meal table allows in this meal
  // as a main, not only as a side (an egg on toast: eggs are breakfast mains).
  // Slots name their groups, so this only widens the toast topping and the
  // egg plate's vegetables; the meal table still decides which foods exist
  // in the meal at all.
  const sideIds = new Set(sides.map((f) => f.id));
  const slotFoods = [...sides, ...mains.filter((f) => !sideIds.has(f.id))];
  const usableSides = slotFoods.filter((f) => !excludeFoodIds.has(f.id) && isSideWorthy(f));

  const fits = (plate) => plate && Math.abs(plate.fit - 1) <= MAX_ENERGY_MISS;
  const candidates = [];
  const mainById = new Map();
  for (const main of shuffled(usableMains, rand).slice(0, MAINS_TRIED)) {
    mainById.set(main.id, main);
    const plate = buildOne({ main, sides: usableSides, meal, target: targetKcal, rand, bonusFor, serveTarget });
    if (fits(plate)) candidates.push(plate);
  }
  candidates.sort((a, b) => b.score - a.score);

  const plates = [];
  const sideUse = new Map();
  const mainGroupUse = new Map();
  const mainIds = new Set();
  const mainKinds = new Set(); // "pizza" once per meal, however many pizzas exist
  for (const candidate of candidates) {
    if (plates.length >= count) break;
    let plate = candidate;
    const main = plate.items[0];
    const kind = String(main.name || "").split(",")[0].trim().toLowerCase();
    if (mainIds.has(main.foodId)) continue;
    if (kind && mainKinds.has(kind)) continue;
    if ((mainGroupUse.get(main.group) || 0) >= MAX_PER_MAIN_GROUP) continue;
    const overused = (id) => (sideUse.get(id) || 0) >= MAX_SIDE_REPEAT;
    if (plate.items.slice(1).some((i) => overused(i.foodId))) {
      // Same main, sides not yet used twice. Without this a good main is lost
      // only because its first sides were popular.
      const retry = buildOne({
        main: mainById.get(main.foodId), sides: usableSides.filter((s) => !overused(s.id)),
        meal, target: targetKcal, rand, bonusFor, serveTarget,
      });
      if (!fits(retry)) continue;
      plate = retry;
    }
    const sideIds = plate.items.slice(1).map((i) => i.foodId);
    plates.push(plate);
    mainIds.add(main.foodId);
    if (kind) mainKinds.add(kind);
    mainGroupUse.set(main.group, (mainGroupUse.get(main.group) || 0) + 1);
    for (const id of sideIds) sideUse.set(id, (sideUse.get(id) || 0) + 1);
  }
  return { plates, shortBy: Math.max(0, count - plates.length) };
};
