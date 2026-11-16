// Standard drinks from the meal log (checklist m4-10).
//
// alcoholBudget.js knows the NHMRC limits and summariseAlcohol() checks a
// rolling 7-day window, but it needs drinks per day. This file reads them out
// of meal_logs.nutrients.alcohol_g.
//
// Unknown is COUNTED, never zeroed (ERROR_LOG 015). 0 g is a real "known
// none" (AUSNUT stores 0 for non-alcoholic foods). A missing or null alcohol_g
// means we do not know: FatSecret, manual, recognition and Open Food Facts
// live logs carry no gram figure, and most logs made before m4-10 have none.
// Adding those as 0 would make an unknown week look "all clear", so they are
// returned separately as unknownByDate / unknownLogsInWindow and any screen
// must say the figure is incomplete.
//
// Servings rule: alcohol_g follows the SAME rule as meal_logs.calories. It is
// the TOTAL for the row's servings when the row was logged (the barcode
// mapper multiplies by the chosen quantity; the search path logs servings=1),
// so it is used as is, never multiplied by `servings` again.
// KNOWN GAP: PUT /api/meals/update/:id (the Meal Summary +/-) rescales
// calories/protein/carbs/fats but never rewrites `nutrients`, so after a +/-
// alcohol_g still describes the servings at log time. See the m4-10 report.
//
// Nothing shows this yet. The screen is m6-04, and m4-08 (a real date of
// birth) must land before any screen shows the budget to real users.
import { and, eq, gte, lte } from "drizzle-orm";

import { mealLogsTable } from "../db/schema.js";
import { GRAMS_PER_STANDARD_DRINK, summariseAlcohol } from "./alcoholBudget.js";

const dateKey = (value) => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
};

/**
 * Standard drinks in one meal_logs row.
 * @returns {{ drinks: number|null }}  null when the alcohol figure is unknown
 */
export const standardDrinksForLog = (log) => {
  const raw = log?.nutrients?.alcohol_g;
  // Number(null) is 0 and Number("") is 0, so check for "no value" first.
  if (raw === null || raw === undefined || raw === "") return { drinks: null };
  const grams = Number(raw);
  if (!Number.isFinite(grams) || grams < 0) return { drinks: null };
  return { drinks: grams / GRAMS_PER_STANDARD_DRINK };
};

/**
 * @param {object[]} logs  meal_logs rows (date, nutrients)
 * @returns {{ drinksByDate: Record<string, number>, unknownByDate: Record<string, number> }}
 *   drinksByDate holds only KNOWN drinks; unknownByDate counts logs per day
 *   whose alcohol is unknown. A day can appear in both.
 */
export const drinksByDateFromLogs = (logs = []) => {
  const drinksByDate = {};
  const unknownByDate = {};
  for (const log of logs) {
    const day = dateKey(log?.date);
    if (!day) continue;
    const { drinks } = standardDrinksForLog(log);
    if (drinks === null) {
      unknownByDate[day] = (unknownByDate[day] || 0) + 1;
    } else {
      drinksByDate[day] = (drinksByDate[day] || 0) + drinks;
    }
  }
  return { drinksByDate, unknownByDate };
};

/**
 * The budget summary for `date`, read from the user's logs.
 *
 * The window comes from summariseAlcohol itself (its windowStart/windowEnd),
 * so there is exactly one definition of the rolling 7 days (WINDOW_DAYS).
 *
 * @param {object} args
 * @param {object} args.db      drizzle instance, injected so tests can fake it
 * @param {number} args.userId
 * @param {string} args.date    YYYY-MM-DD
 * @param {object} args.budget  from resolveAlcoholBudget
 * @returns {Promise<object>}   summariseAlcohol(...) plus unknownLogsInWindow
 */
export const getAlcoholSummary = async ({ db, userId, date, budget }) => {
  // Throws on a bad date, before any query runs.
  const { windowStart, windowEnd } = summariseAlcohol({ budget, drinksByDate: {}, date });

  const logs = await db
    .select({ date: mealLogsTable.date, nutrients: mealLogsTable.nutrients })
    .from(mealLogsTable)
    .where(
      and(
        eq(mealLogsTable.userId, userId),
        gte(mealLogsTable.date, windowStart),
        lte(mealLogsTable.date, windowEnd)
      )
    );

  const { drinksByDate, unknownByDate } = drinksByDateFromLogs(logs);
  // summariseAlcohol only sums days inside the window. Unknown counts are
  // bounded the same way, so a row outside it can never leak in.
  const unknownLogsInWindow = Object.entries(unknownByDate)
    .filter(([day]) => day >= windowStart && day <= windowEnd)
    .reduce((sum, [, count]) => sum + count, 0);

  return { ...summariseAlcohol({ budget, drinksByDate, date }), unknownLogsInWindow };
};
