// How the day's calorie target is divided between meals (checklist m4-05).
// The ONE split for the planner. Before this file there were two that
// disagreed: mealPlan.js used 30/35/35 and the retired ML path
// (routes/recommendation/) used 20/30/50.
//
// Default 25 / 30 / 35 / 10 (breakfast / lunch / dinner / snack), decided
// 2026-11-16. Why:
//   - The Australian Dietary Guidelines set DAILY serves only. There is no
//     official per-meal split to copy, so this is a product choice, written
//     down here rather than presented as a guideline.
//   - The best trial on it (Ruddick-Collins et al., Cell Metabolism 2022)
//     compared 45/35/20 against 20/35/45 at equal calories: the same weight
//     loss, but less hunger when more was eaten earlier. So the split is
//     about comfort, and a moderate lean away from dinner is reasonable
//     without forcing a large breakfast people will not eat.
//   - The snack is sized by what it should hold, one fruit serve (~350 kJ)
//     plus one dairy serve (~550 kJ): about 215 kcal, ~10% of a 2,100 kcal day.
//
// Tunable without a code change: set MEAL_SPLIT on Railway, e.g.
//   MEAL_SPLIT=25,30,35,10
// in the order of MEAL_SLOTS, as whole percentages summing to 100. Railway
// restarts the backend when a variable changes. An invalid value is IGNORED
// (default used, one warning logged) rather than crashing the server or
// silently planning a broken day.

import { MEAL_TYPES } from "./mealTypes.js";

// The slots are the shared meal types (services/mealTypes.js, m4-09). The
// name MEAL_SLOTS stays because the planner and its tests import it.
export const MEAL_SLOTS = MEAL_TYPES;

export const DEFAULT_MEAL_SPLIT = Object.freeze({
  breakfast: 0.25,
  lunch: 0.3,
  dinner: 0.35,
  snack: 0.1,
});

/**
 * Parse a MEAL_SPLIT value. Returns { split, error }: on any problem `split`
 * is the default and `error` says why, so the caller can log it once.
 * Empty or missing is not an error; it just means "use the default".
 */
export const parseMealSplit = (raw) => {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { split: DEFAULT_MEAL_SPLIT, error: null };
  }
  const parts = String(raw).split(",").map((part) => part.trim());
  const fail = (error) => ({ split: DEFAULT_MEAL_SPLIT, error });

  if (parts.length !== MEAL_SLOTS.length) {
    return fail(`expected ${MEAL_SLOTS.length} numbers (${MEAL_SLOTS.join(",")}), got ${parts.length}`);
  }
  const numbers = parts.map(Number);
  if (numbers.some((n, i) => parts[i] === "" || !Number.isFinite(n) || n < 0)) {
    return fail("every value must be a number of 0 or more");
  }
  const total = numbers.reduce((sum, n) => sum + n, 0);
  if (Math.abs(total - 100) > 0.5) {
    return fail(`values must add up to 100, got ${total}`);
  }
  const split = {};
  MEAL_SLOTS.forEach((slot, i) => {
    split[slot] = numbers[i] / total;
  });
  return { split: Object.freeze(split), error: null };
};

// Read once at startup. A changed variable restarts the process on Railway,
// so there is nothing to re-read.
const { split: CONFIGURED_SPLIT, error: CONFIG_ERROR } = parseMealSplit(process.env.MEAL_SPLIT);
if (CONFIG_ERROR) {
  console.warn(`[mealSplit] MEAL_SPLIT ignored (${CONFIG_ERROR}); using the default 25,30,35,10.`);
}

/** The split in force: MEAL_SPLIT if valid, otherwise the default. */
export const getMealSplit = () => CONFIGURED_SPLIT;

/**
 * Calories per meal slot.
 *
 * `slots` is the meals actually being planned. The shares of those slots are
 * scaled up to cover the WHOLE day, so a plan never comes up short just
 * because a slot is not offered. That matters now: the planner fills only
 * breakfast, lunch and dinner until the snack slot exists (m5-04), so with
 * the default it gives 27.8 / 33.3 / 38.9% rather than 25 / 30 / 35 and
 * losing 10% of the day. Once the snack is planned, pass all four slots and
 * the split applies exactly.
 *
 * Unknown slot names are ignored. Rounded to whole calories; the rounding can
 * leave the total a calorie or two off the daily target, which is noise.
 *
 * @param {number} dailyCalories
 * @param {object} [opts]
 * @param {string[]} [opts.slots=MEAL_SLOTS]
 * @param {object}   [opts.split=getMealSplit()]  injectable for tests
 * @returns {Record<string, number>}
 */
export const buildMealCalorieTargets = (
  dailyCalories,
  { slots = MEAL_SLOTS, split = getMealSplit() } = {}
) => {
  const active = slots.filter((slot) => MEAL_SLOTS.includes(slot));
  const activeShare = active.reduce((sum, slot) => sum + (split[slot] || 0), 0);
  const daily = Number(dailyCalories);
  const targets = {};
  for (const slot of active) {
    const share = activeShare > 0 ? (split[slot] || 0) / activeShare : 1 / active.length;
    targets[slot] = Number.isFinite(daily) && daily > 0 ? Math.round(daily * share) : 0;
  }
  return targets;
};
