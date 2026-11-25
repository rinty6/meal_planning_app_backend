// Builds the planner's snacks (checklist m5-04, task P4, 2026-11-20).
//
// A snack is one food from the five food groups, or a pair people actually
// eat (decisions D1 and D2 in SNACK_SLOT_DESIGN.html, approved 2026-11-20).
// Never a cake, a custard or a corn snack: those groups have no snack role in
// the meal table any more, and a food with no snack FAMILY below is never
// used even if it is passed in.
//
// The result is shaped exactly like plateBuilder.buildPlates, so
// catalogPlates.plateToItem and the app render a snack as a plate card.
//
// Pure: no database, no network. Seeded, so the same seed gives the same
// snacks and Shuffle sends a new seed.
import {
  MAX_ENERGY_MISS,
  MAX_PER_MAIN_GROUP,
  MAX_SIDE_REPEAT,
  NEED_WEIGHT,
  PLATES_PER_MEAL,
  RAW_IS_NORMAL,
  bestPortion,
  itemFor,
  kcalPerGram,
  kindOf,
  plateTitle,
  portionsFor,
  primaryGroup,
  scorePlate,
  seededRandom,
  serveCoverage,
  servesFor,
  shuffled,
  sumPlate,
} from "./plateBuilder.js";

const ADG_GROUPS = ["grain", "vegetable", "fruit", "dairy", "protein"];
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `ausnut-${from + i}`);

// P4, 2026-11-20: snack families by AUSNUT sub-group (BUILD_BRIEF P4 step 3).
const FAMILY_GROUPS = Object.freeze({
  fruit: range(161, 168),
  yoghurt: ["ausnut-192", "ausnut-205"],
  cheese: ["ausnut-194", "ausnut-203"],
  milk: ["ausnut-191", "ausnut-201"],
  nuts: ["ausnut-221", "ausnut-222"],
  crackers: ["ausnut-132"],
  dip: ["ausnut-235"],
  rawveg: range(243, 247),
});
const FAMILY_OF = new Map(Object.entries(FAMILY_GROUPS).flatMap(([family, codes]) => codes.map((c) => [c, family])));

// P4, 2026-11-20: the pairs people eat (SNACK_SLOT_DESIGN section 2, decision
// D2). Written one way round, read both ways: "fruit with cheese" also lets a
// cheese snack take a fruit.
const PAIR_LIST = [
  ["fruit", ["cheese", "yoghurt", "nuts"]],
  ["yoghurt", ["fruit", "nuts"]], // "nuts and seeds": 221 seeds sits in the nuts family
  ["cheese", ["fruit", "crackers", "rawveg"]],
  ["rawveg", ["dip", "cheese"]],
  ["crackers", ["cheese", "dip"]],
  ["milk", ["fruit"]],
  ["nuts", ["fruit", "yoghurt"]],
];
export const SNACK_PAIRS = Object.freeze(
  PAIR_LIST.reduce((acc, [a, partners]) => {
    for (const b of partners) {
      (acc[a] ||= new Set()).add(b);
      (acc[b] ||= new Set()).add(a);
    }
    return acc;
  }, {})
);

// P4, 2026-11-20: these never stand alone. A rice cake alone is 8 kcal, a dip
// is eaten on something, and vegetable sticks come with a dip or cheese.
const PAIR_ONLY = new Set(["crackers", "dip", "rawveg"]);
// P4, 2026-11-20: the ADG counts 30 g of dried fruit as a fruit serve "only
// occasionally", so at most one of the five snacks carries it.
const DRIED_FRUIT_GROUP = "ausnut-168";
const MAX_DRIED_FRUIT = 1;
// P4, 2026-11-20: the half-serve rule. Every snack food, at its portion,
// gives at least half a serve of one of the five food groups ("a snack from
// the five food groups", Eat for Health). Catches 1 tbsp of coconut, 1 rice
// cake and an unfortified almond drink.
export const MIN_SNACK_SERVE = 0.5;

const FIRST_FOODS_TRIED = 60; // as MAINS_TRIED in plateBuilder
const PARTNERS_TRIED = 40; // as SIDES_TRIED in plateBuilder

/** The snack family of a food ("fruit", "cheese"...), or null when it is not a snack food. */
export const snackFamily = (food) => {
  const family = FAMILY_OF.get(food?.group) || null;
  if (family !== "rawveg") return family;
  // Raw vegetables only when raw and normally eaten raw (the plate side rule).
  return /\braw\b/i.test(food?.name || "") && RAW_IS_NORMAL.has(kindOf(food)) ? "rawveg" : null;
};

/** True when `grams` of `food` give at least MIN_SNACK_SERVE of some food group. */
export const passesHalfServe = (food, grams) => {
  const serves = servesFor(food, grams);
  return ADG_GROUPS.some((g) => serves[g] >= MIN_SNACK_SERVE);
};

/**
 * A normal portion: one of the food's own servings (or 100 g), quantity 1,
 * nearest `wantKcal`; the default serving wins a near tie. This is how a
 * single snack is sized, so an apple stays "1 apple", never "2 apples".
 */
// 2026-11-25 (live check on a 2,991 kcal day): with no upper limit a snack
// was "300 g of raw lettuce and 200 g of dip" or "radish and 158 g of feta".
// Each food in a snack stays within SNACK_PART_SERVINGS of its ordinary
// serving and never above SNACK_PART_MAX_G; a big day gets more snacks'
// worth of energy elsewhere, not a bigger block of cheese.
const SNACK_PART_SERVINGS = 2;
const SNACK_PART_MAX_G = 200;
export const snackPartMaxGrams = (food) => {
  const def = (food?.servings || []).find((s) => s.isDefault)?.grams || 100;
  return Math.min(SNACK_PART_MAX_G, SNACK_PART_SERVINGS * def);
};

const normalPortion = (food, wantKcal) => {
  const perGram = kcalPerGram(food);
  if (perGram <= 0) return null;
  const slack = Math.max(wantKcal, 50) * 0.04; // as bestPortion
  const maxGrams = snackPartMaxGrams(food);
  let best = null;
  for (const p of portionsFor(food, "side")) {
    if (p.quantity !== 1 || p.grams > maxGrams) continue;
    const kcal = p.grams * perGram;
    const score = Math.abs(kcal - wantKcal) + (p.isDefault ? 0 : slack);
    if (!best || score < best.score) best = { ...p, kcal, score };
  }
  return best;
};

/** Missing serves per group as a share of the largest gap: 1 for the group the snack lacks most. */
const lackShare = (serveTarget) => {
  const missing = Object.fromEntries(ADG_GROUPS.map((g) => [g, Math.max(0, Number(serveTarget?.[g]) || 0)]));
  const most = Math.max(...Object.values(missing));
  return Object.fromEntries(ADG_GROUPS.map((g) => [g, most > 0 ? missing[g] / most : 0]));
};

const snackPlate = ({ parts, target, rand, bonusFor, serveTarget, firstLack }) => {
  const items = parts.map(({ food, portion }, i) => itemFor(food, i === 0 ? "main" : "side", portion));
  const totals = sumPlate(items);
  const unusual = parts.filter(({ portion }) => portion.quantity !== 1 || !portion.isDefault).length;
  const personal = items.reduce((sum, item) => sum + bonusFor({ id: item.foodId }), 0);
  return {
    id: `plate_snack_${items.map((i) => `${i.foodId}x${i.grams}`).join("_")}`,
    meal: "snack",
    shape: "snack",
    title: plateTitle(items.map((i) => i.shortName)),
    items,
    totals,
    target: Math.round(target),
    fit: Math.round((totals.kcal / target) * 100) / 100,
    serveTarget: serveTarget || null,
    serveCoverage: serveCoverage(totals.serves, serveTarget),
    // The first food leans toward the group the snack lacks most (NEED_WEIGHT,
    // the weight plateBuilder gives a side that fills a gap).
    score: scorePlate(totals, target, "snack", personal, unusual, serveTarget) + firstLack * NEED_WEIGHT + rand() * 0.02,
  };
};

/**
 * Every snack this first food can make: alone (when allowed and a normal
 * portion fits) and as the first food of its best pair.
 */
const snacksFrom = ({ first, partners, target, rand, bonusFor, serveTarget, lack }) => {
  const out = [];
  const family = snackFamily(first);
  const firstLack = lack[primaryGroup(first)] || 0;
  const inWindow = (kcal) => Math.abs(kcal / target - 1) <= MAX_ENERGY_MISS;

  if (!PAIR_ONLY.has(family)) {
    const alone = normalPortion(first, target);
    if (alone && inWindow(alone.kcal) && passesHalfServe(first, alone.grams)) {
      out.push(snackPlate({ parts: [{ food: first, portion: alone }], target, rand, bonusFor, serveTarget, firstLack }));
    }
  }

  // The pair: the first food at a normal portion near half the snack, the
  // second sized to fit what is left.
  const firstPortion = normalPortion(first, target / 2);
  if (!firstPortion || !passesHalfServe(first, firstPortion.grams)) return out;
  const allowed = SNACK_PAIRS[family] || new Set();
  let best = null;
  for (const partner of partners) {
    if (partner.id === first.id || kindOf(partner) === kindOf(first)) continue;
    if (!allowed.has(snackFamily(partner))) continue;
    const portion = bestPortion(partner, target - firstPortion.kcal, "side", { maxGrams: snackPartMaxGrams(partner) });
    if (!portion || !passesHalfServe(partner, portion.grams)) continue;
    const total = firstPortion.kcal + portion.kcal;
    if (!inWindow(total)) continue;
    // Energy fit first; the same small random and personal terms as sideScore.
    const score = -Math.abs(total - target) / target + rand() * 0.06 + Math.min(bonusFor(partner), 0.02);
    if (!best || score > best.score) best = { partner, portion, score };
  }
  if (best) {
    out.push(snackPlate({
      parts: [{ food: first, portion: firstPortion }, { food: best.partner, portion: best.portion }],
      target, rand, bonusFor, serveTarget, firstLack,
    }));
  }
  return out;
};

/**
 * @param {object}   args
 * @param {object[]} args.foods       candidatesForMeal(pool, "snack"): mains and sides together
 * @param {number}   args.targetKcal  the snack's energy target (mealSplit.js)
 * @param {object}   [args.serveTarget] the snack's serves (mealServePattern.mealServeTargets)
 * @param {number}   [args.seed]
 * @param {number}   [args.count]
 * @param {(food:{id:number})=>number} [args.bonusFor]
 * @param {Set<number>} [args.excludeFoodIds]
 * @returns {{ plates: object[], shortBy: number }}
 */
export const buildSnacks = ({
  foods = [],
  targetKcal,
  serveTarget = null,
  seed = 1,
  count = PLATES_PER_MEAL,
  bonusFor = () => 0,
  excludeFoodIds = new Set(),
  accept = () => true, // 2026-11-25: nutrient filters on the whole snack (as plates)
} = {}) => {
  if (!Number.isFinite(targetKcal) || targetKcal <= 0) return { plates: [], shortBy: count };
  const rand = seededRandom(seed);
  const seen = new Set();
  const usable = foods.filter((f) => {
    if (!f || seen.has(f.id) || excludeFoodIds.has(f.id)) return false;
    seen.add(f.id);
    return snackFamily(f) !== null;
  });
  const lack = lackShare(serveTarget);
  const partners = shuffled(usable, rand).slice(0, PARTNERS_TRIED * 4);

  const candidates = [];
  for (const first of shuffled(usable, rand).slice(0, FIRST_FOODS_TRIED)) {
    candidates.push(...snacksFrom({ first, partners, target: targetKcal, rand, bonusFor, serveTarget, lack }).filter(accept));
  }
  candidates.sort((a, b) => b.score - a.score);

  // The same variety rules as plates: a first food's kind once, at most
  // MAX_PER_MAIN_GROUP first foods from one group, no food on more than
  // MAX_SIDE_REPEAT snacks, and dried fruit on at most MAX_DRIED_FRUIT.
  const plates = [];
  const use = new Map();
  const firstKinds = new Set();
  const firstGroupUse = new Map();
  let driedFruit = 0;
  const foodSets = new Set(); // "Apple & cheddar" and "Cheddar & apple" are one snack
  for (const plate of candidates) {
    if (plates.length >= count) break;
    const [first] = plate.items;
    const foodSet = plate.items.map((i) => i.foodId).sort((a, b) => a - b).join("+");
    if (foodSets.has(foodSet)) continue;
    const kind = kindOf(first);
    if (firstKinds.has(kind)) continue;
    if ((firstGroupUse.get(first.group) || 0) >= MAX_PER_MAIN_GROUP) continue;
    if (plate.items.some((i) => (use.get(i.foodId) || 0) >= MAX_SIDE_REPEAT)) continue;
    const dried = plate.items.some((i) => i.group === DRIED_FRUIT_GROUP);
    if (dried && driedFruit >= MAX_DRIED_FRUIT) continue;
    plates.push(plate);
    foodSets.add(foodSet);
    firstKinds.add(kind);
    firstGroupUse.set(first.group, (firstGroupUse.get(first.group) || 0) + 1);
    for (const i of plate.items) use.set(i.foodId, (use.get(i.foodId) || 0) + 1);
    if (dried) driedFruit += 1;
  }
  return { plates, shortBy: Math.max(0, count - plates.length) };
};
