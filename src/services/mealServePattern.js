// How a day's food-group serves are spread across meals (checklist m5-03).
//
// The Australian Dietary Guidelines give serves per DAY (adgServeTargets.js)
// and say nothing about which meal should carry them. The user chose, on
// 2026-11-19, a meal pattern that follows how people actually eat, over
// splitting every group like energy (which would ask for ~1.4 vegetable serves
// at breakfast). There is no official source for these shares: like the
// energy split (mealSplit.js) they are a tunable table, and this comment is
// the place to record why a number changes.
//
// Measured before this existed (2026-11-19, 40 sets of live plates per meal):
// plates already met a woman 19-50's day on AVERAGE, but 45-53% of lunches
// and dinners had no dairy, 34% of breakfasts had no protein, and nothing
// adapted to people who need more: a woman 51-70 needs 4 dairy serves, a
// pregnant woman 8.5 grain and 3.5 protein. Scoring against this pattern,
// with each user's own daily targets, is what fixes that.
//
// P3, 2026-11-20: lunch's fruit and dairy share moves to the snack (user
// decision of 2026-11-20). Australians eat their fruit at breakfast or as a
// snack, and lunch is mostly a sandwich or a wrap (HOW_AUSTRALIANS_EAT.html).
// Asking lunch for 35% of the day's fruit made lunch plates look like a snack
// platter ("Hamburger + frozen strawberries + protein yoghurt"). Fruit was
// 0.4 / 0.35 / 0 / 0.25 and dairy 0.35 / 0.25 / 0.15 / 0.25.
//
// The snack column is already here so m5-04 only has to turn the slot on.
// Until then the planner fills three meals and the shares are rescaled over
// the meals it fills, exactly as the energy split is.
import { SERVE_GROUPS } from "./adgServeTargets.js";

export const MEAL_SERVE_PATTERN = Object.freeze({
  //            breakfast lunch dinner snack     (each row sums to 1)
  vegetable: Object.freeze({ breakfast: 0, lunch: 0.4, dinner: 0.6, snack: 0 }),
  fruit: Object.freeze({ breakfast: 0.4, lunch: 0.1, dinner: 0, snack: 0.5 }), // P3, 2026-11-20
  grain: Object.freeze({ breakfast: 0.3, lunch: 0.3, dinner: 0.35, snack: 0.05 }),
  protein: Object.freeze({ breakfast: 0.2, lunch: 0.35, dinner: 0.45, snack: 0 }),
  dairy: Object.freeze({ breakfast: 0.35, lunch: 0.15, dinner: 0.15, snack: 0.35 }), // P3, 2026-11-20
});

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Daily serves -> serves each meal should aim for, over the meals being filled.
 *
 * @param {object} daily  { vegetable, fruit, grain, protein, dairy } (adgServeTargets)
 * @param {object} [opts]
 * @param {string[]} [opts.slots] meals the planner fills (default: all four)
 * @returns {Record<string, Record<string, number>>} meal -> group -> serves
 */
export const mealServeTargets = (daily = {}, { slots = ["breakfast", "lunch", "dinner", "snack"] } = {}) => {
  const out = Object.fromEntries(slots.map((m) => [m, {}]));
  for (const group of SERVE_GROUPS) {
    const shares = MEAL_SERVE_PATTERN[group];
    const covered = slots.reduce((sum, m) => sum + (shares[m] || 0), 0);
    const total = Number(daily?.[group]) || 0;
    for (const meal of slots) {
      // 2026-11-25 (iPhone test): with breakfast, lunch and dinner logged and
      // 1.4 vegetable serves still missing, only the snack was left, and its
      // pattern share of vegetables is 0, so the gap was dropped and the
      // snack never offered vegetables ("Vegetables short today" could not
      // clear). When none of the remaining meals normally carries a group,
      // what is missing is shared equally between them instead.
      const share = covered > 0 ? (shares[meal] || 0) / covered : 1 / slots.length;
      out[meal][group] = round2(total * share);
    }
  }
  return out;
};
