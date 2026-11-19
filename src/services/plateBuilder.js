// Builds the planner's plates (checklist m5-01, step 2).
//
// A plate is one MAIN plus one or two SIDES, sized together toward the meal's
// energy target (decision D1, 2026-11-19). Pure: it takes the candidates from
// plannerPool.candidatesForMeal and returns plates. No database, no network,
// so it runs in milliseconds on the in-memory pool and is fully testable.
//
// How a plate is built
//   1. Choose the SIDES first, at ordinary portions: the food's default
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
// Serve targets are NOT scored here yet: that is m5-03, which will add a term
// to scorePlate. The food-group variety term is its placeholder.

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
// Raw is how these are normally eaten; other raw vegetables lose at dinner.
const RAW_IS_NORMAL = new Set(["ausnut-244", "ausnut-246"]);
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

const shuffled = (items, rand) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/** kcal per gram; falls back to kJ when kcal is missing. */
const kcalPerGram = (food) => {
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
export const bestPortion = (food, wantKcal, role = "side") => {
  const perGram = kcalPerGram(food);
  if (perGram <= 0) return null;
  const slack = Math.max(wantKcal, 50) * 0.04;
  let best = null;
  for (const p of portionsFor(food, role)) {
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

const servesFor = (food, grams) => {
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

const itemFor = (food, role, portion) => ({
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

/** Higher is better. */
export const scorePlate = ({ kcal, serves }, target, meal, personal = 0, unusualPortions = 0) => {
  const fit = Math.abs(kcal - target) / target;
  const groups = ADG_GROUPS.filter((g) => serves[g] >= SERVE_COUNTS_FROM).length;
  const vegBonus = (meal === "lunch" || meal === "dinner") && serves.vegetable >= 0.5 ? 0.1 : 0;
  return -fit + groups * 0.05 + vegBonus - unusualPortions * 0.02 + Math.min(personal, 0.05);
};

/** How much a side suits this meal and this plate. Higher is better. */
const sideScore = (side, meal, rand, bonusFor) => {
  const g = primaryGroup(side);
  const order = SIDE_ORDER[meal] || [];
  const rank = order.indexOf(g);
  const orderBonus = rank === -1 ? 0 : (order.length - rank) * 0.05;
  const preferred = PREFERRED_SIDES[meal]?.has(side.group) ? 0.3 : 0;
  const sugar = ADDED_SUGAR.test(side.name || "") ? -0.15 : 0;
  const rawAtDinner = meal === "dinner" && /\braw\b/i.test(side.name || "") && !RAW_IS_NORMAL.has(side.group) ? -0.25 : 0;
  return preferred + orderBonus + sugar + rawAtDinner + Math.min(bonusFor(side), 0.02) + rand() * 0.06;
};

/** The kind of food: the first clause of its name ("salad", "pizza", "rice"). */
const kindOf = (food) => String(food?.name || "").split(",")[0].trim().toLowerCase();

const buildOne = ({ main, sides, meal, target, rand, bonusFor }) => {
  // 1. Sides, at ordinary portions.
  const chosen = [];
  const usedGroups = new Set([primaryGroup(main)]);
  const usedFoods = new Set([main.id]);
  // No caesar salad beside a caesar salad: one food of each kind per plate.
  const usedKinds = new Set([kindOf(main)]);
  const pool = shuffled(sides, rand).slice(0, SIDES_TRIED * 4);
  for (let slot = 0; slot < MAX_SIDES; slot += 1) {
    let best = null;
    for (const side of pool) {
      if (usedFoods.has(side.id)) continue;
      if (usedKinds.has(kindOf(side))) continue;
      const g = primaryGroup(side);
      if (usedGroups.has(g)) continue;
      const portion = sidePortion(side);
      if (!portion) continue;
      const score = sideScore(side, meal, rand, bonusFor);
      if (!best || score > best.score) best = { side, portion, g, score };
    }
    if (!best) break;
    chosen.push(best);
    usedGroups.add(best.g);
    usedFoods.add(best.side.id);
    usedKinds.add(kindOf(best.side));
  }

  // 2. The main fills what is left. If two sides leave the main too little,
  //    drop the second side rather than shrink the main to a garnish.
  let mainPortion = null;
  while (chosen.length > 0) {
    const sidesKcal = chosen.reduce((sum, c) => sum + c.portion.kcal, 0);
    const want = target - sidesKcal;
    if (want >= target * MIN_MAIN_SHARE) {
      mainPortion = bestPortion(main, want, "main");
      break;
    }
    chosen.pop();
  }
  if (!mainPortion || chosen.length === 0) return null;

  const items = [itemFor(main, "main", mainPortion), ...chosen.map((c) => itemFor(c.side, "side", c.portion))];
  const unusual = [mainPortion, ...chosen.map((c) => c.portion)]
    .filter((p) => p.quantity !== 1 || !p.isDefault).length;
  const totals = sumPlate(items);
  const personal = items.reduce((sum, item) => sum + bonusFor({ id: item.foodId }), 0);
  return {
    id: `plate_${meal}_${items.map((i) => `${i.foodId}x${i.grams}`).join("_")}`,
    meal,
    title: plateTitle(items.map((i) => i.shortName)),
    items,
    totals,
    target: Math.round(target),
    fit: Math.round((totals.kcal / target) * 100) / 100,
    score: scorePlate(totals, target, meal, personal, unusual) + rand() * 0.02,
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
} = {}) => {
  if (!Number.isFinite(targetKcal) || targetKcal <= 0) return { plates: [], shortBy: count };
  const rand = seededRandom(seed);
  const usableMains = mains.filter((f) => !excludeFoodIds.has(f.id));
  const usableSides = sides.filter((f) => !excludeFoodIds.has(f.id));

  const fits = (plate) => plate && Math.abs(plate.fit - 1) <= MAX_ENERGY_MISS;
  const candidates = [];
  const mainById = new Map();
  for (const main of shuffled(usableMains, rand).slice(0, MAINS_TRIED)) {
    mainById.set(main.id, main);
    const plate = buildOne({ main, sides: usableSides, meal, target: targetKcal, rand, bonusFor });
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
        meal, target: targetKcal, rand, bonusFor,
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
