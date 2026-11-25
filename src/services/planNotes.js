// Naming the constraint a plan cannot meet (checklist m5-06, task T4,
// 2026-11-21). Backend only: no screen shows these yet (m6-07 needs a design);
// the planner payload carries them as `plan_notes`.
//
// Before this the planner missed a goal silently: a pregnancy grain target the
// plates could not reach, a meal with two ideas instead of five, a day already
// past its energy. Each note is a code plus the numbers a screen needs to say
// it in words, for example "pregnancy needs 8.5 grain serves and today's plan
// can reach about 7".
import { SERVE_GROUPS } from "./adgServeTargets.js";
import { PLATES_PER_MEAL } from "./plateBuilder.js";
import { ENERGY_CLAMP } from "./todayIntake.js";

// T4, 2026-11-21: a food group is "out of reach" when the best the plan can do
// is below 90% of the day's target (the brief's rule). Serves are minimums, so
// a small shortfall is not worth a note.
export const SERVE_REACH_SHARE = 0.9;

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * @param {object} args
 * @param {Record<string, object[]>} args.recommendationsByMeal  plate items (plateToItem)
 * @param {Record<string, number>}   [args.shortByMeal]          meal -> how many ideas short of five
 * @param {string[]}                 [args.blocked]              unrecognised preference labels
 * @param {object}                   [args.dailyServes]          the day's ADG serve targets
 * @param {object}                   [args.eatenServes]          from summariseToday
 * @param {number|null}              [args.energyFactor]         from adjustTargets, before the clamp
 * @param {boolean}                  [args.builtAllMeals]        true when every meal was planned
 * @param {Iterable<string>}         [args.loggedMeals]          meals with something logged today
 * @returns {object[]} notes, in the order above
 */
export const planNotes = ({
  recommendationsByMeal = {},
  shortByMeal = {},
  blocked = [],
  dailyServes = {},
  eatenServes = {},
  energyFactor = null,
  builtAllMeals = false,
  loggedMeals = [],
  rowsWithoutServes = 0,
} = {}) => {
  const notes = [];
  // Unknown labels block every plate, so nothing else about the plan is true.
  if (Array.isArray(blocked) && blocked.length > 0) {
    return [{ code: "unknown_preference", labels: [...blocked] }];
  }

  for (const [meal, shortBy] of Object.entries(shortByMeal || {})) {
    if (Number(shortBy) > 0) {
      notes.push({ code: "few_ideas", meal, shown: (recommendationsByMeal[meal] || []).length, wanted: PLATES_PER_MEAL });
    }
  }

  if (Number.isFinite(energyFactor) && energyFactor < ENERGY_CLAMP.min) {
    notes.push({ code: "day_over_energy" });
  }

  // Only a whole-day plan can say a daily target is out of reach.
  // 2026-11-25 (PLAN_STATES_DESIGN.html, user decision): a row logged by
  // barcode, FatSecret or voice has no food groups and counts as 0 serves, so
  // a toast breakfast logged by barcode would read as "no grains" and raise a
  // false "Grains short today". On such a day the serve notes stay silent: a
  // missed warning is better than a false one.
  if (builtAllMeals && !(Number(rowsWithoutServes) > 0)) {
    // T4, 2026-11-21: a meal already logged adds what was eaten, not its best
    // idea, so its plates are left out of the best case.
    const logged = new Set(loggedMeals);
    for (const group of SERVE_GROUPS) {
      const target = Number(dailyServes?.[group]) || 0;
      if (target <= 0) continue;
      let best = Number(eatenServes?.[group]) || 0;
      for (const [meal, items] of Object.entries(recommendationsByMeal)) {
        if (logged.has(meal) || !Array.isArray(items) || items.length === 0) continue;
        best += Math.max(...items.map((item) => Number(item?.plate?.serves?.[group]) || 0));
      }
      if (best < target * SERVE_REACH_SHARE) {
        notes.push({ code: "serve_target_out_of_reach", group, target: round1(target), best: round1(best) });
      }
    }
  }
  return notes;
};
