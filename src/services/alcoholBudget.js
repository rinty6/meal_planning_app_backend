// Standard-drink budget (checklist m4-07, policy m0-07 and m0-08).
//
// Source: NHMRC Australian Guidelines to Reduce Health Risks from Drinking
// Alcohol (2020), eatforhealth.gov.au / nhmrc.gov.au.
//   Guideline 1  healthy adults: no more than 10 standard drinks a week and
//                no more than 4 on any one day
//   Guideline 2  under 18: no alcohol
//   Guideline 3  pregnant, planning a pregnancy, or breastfeeding: no alcohol
// One standard drink is 10 g of pure alcohol, whatever the drink.
//
// The NHMRC frames these as LOWER RISK, not safe: there is no level of
// drinking that is beneficial. So this is a ceiling the app reports against,
// never a target to fill, and the planner never suggests alcohol (m5-05).
//
// Unknown age gets ZERO, not the adult limits. The under-18 rule is absolute
// and an unknown is never "free" (ERROR_LOG 015). In practice every onboarded
// user has an age; only a missing profile lands here.
//
// KNOWN LIMIT until m4-08 ships: onboarding stores 1 January of the birth
// year, so a 17-year-old can be treated as 18 up to 11 months early. This
// module is correct for the age it is given; m4-08 must land before any
// screen shows this budget to real users.
import { resolveLifeStage } from "./lifeStage.js";

export const GRAMS_PER_STANDARD_DRINK = 10;
export const ADULT_WEEKLY_MAX = 10;
export const ADULT_DAILY_MAX = 4;
export const MIN_DRINKING_AGE = 18;

// The weekly limit is checked over a ROLLING 7 days (the day itself and the
// six before it), not a calendar week. The guideline says "a week" and names
// no start day; a calendar reset would allow 10 drinks on a Sunday and 10 more
// on the Monday with neither week over the limit.
export const WINDOW_DAYS = 7;

const none = (reason) => ({ weeklyMax: 0, dailyMax: 0, reason, source: "nhmrc" });

/**
 * @param {object} person  same shape as resolveServeTargets / resolveWaterTarget
 * @returns {{ weeklyMax: number, dailyMax: number, reason: string, source: string }}
 *   reason: "adult" | "under_18" | "pregnant" | "breastfeeding" | "age_unknown"
 */
export const resolveAlcoholBudget = (person = {}) => {
  const { age } = person;
  if (!Number.isFinite(age) || age <= 0) return { ...none("age_unknown"), source: "nhmrc_default" };
  if (age < MIN_DRINKING_AGE) return none("under_18");

  // Same rule as the serve and water rows (pregnancy is ignored for a male
  // user), so the three targets can never disagree about who this person is.
  const stage = resolveLifeStage(person);
  if (stage.keys.some((key) => key.startsWith("pregnant_"))) return none("pregnant");
  if (stage.keys.some((key) => key.startsWith("lactating_"))) return none("breastfeeding");

  return { weeklyMax: ADULT_WEEKLY_MAX, dailyMax: ADULT_DAILY_MAX, reason: "adult", source: "nhmrc" };
};

/**
 * Standard drinks in an amount of a food. AUSNUT's alcohol is grams per 100 g
 * and the serving is in grams, so no alc/vol figure or density is needed.
 * Returns null, not 0, when the alcohol figure is missing: unknown is not none.
 */
export const standardDrinks = (alcoholGPer100g, grams) => {
  const alcohol = Number(alcoholGPer100g);
  const amount = Number(grams);
  if (alcoholGPer100g == null || !Number.isFinite(alcohol) || !Number.isFinite(amount)) return null;
  return (alcohol * amount) / 100 / GRAMS_PER_STANDARD_DRINK;
};

// Calendar arithmetic on YYYY-MM-DD in UTC, so a daylight-saving change can
// never make a "day" 23 or 25 hours long and shift the window.
const shiftDate = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const oneDecimal = (n) => Math.round(n * 10) / 10;

/**
 * How much of the budget is used and left on a given day.
 *
 * @param {object} args
 * @param {object} args.budget        from resolveAlcoholBudget
 * @param {Record<string, number>} args.drinksByDate  standard drinks per YYYY-MM-DD
 * @param {string} args.date          the day being viewed, YYYY-MM-DD
 */
export const summariseAlcohol = ({ budget, drinksByDate = {}, date }) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new Error("summariseAlcohol needs a YYYY-MM-DD date");
  }
  const windowStart = shiftDate(date, -(WINDOW_DAYS - 1));
  let weekUsed = 0;
  for (let i = 0; i < WINDOW_DAYS; i += 1) {
    weekUsed += Number(drinksByDate[shiftDate(windowStart, i)]) || 0;
  }
  const todayUsed = Number(drinksByDate[date]) || 0;

  // A day's room is whichever limit is closer: 4 today, or what is left of
  // the 10 across the last 7 days.
  const weeklyRemaining = Math.max(0, budget.weeklyMax - weekUsed);
  const dailyRemaining = Math.max(0, Math.min(budget.dailyMax - todayUsed, weeklyRemaining));

  // Compare at one decimal, the precision Australian labels print, so 4.0000001
  // from float sums is not reported as over the limit.
  return {
    windowStart,
    windowEnd: date,
    todayUsed: oneDecimal(todayUsed),
    weekUsed: oneDecimal(weekUsed),
    dailyRemaining: oneDecimal(dailyRemaining),
    weeklyRemaining: oneDecimal(weeklyRemaining),
    overDaily: oneDecimal(todayUsed) > budget.dailyMax,
    overWeekly: oneDecimal(weekUsed) > budget.weeklyMax,
  };
};
