// Planning around what is already logged today (checklist m5-04, task P5,
// 2026-11-20; SNACK_SLOT_DESIGN.html section 3, decision D4).
//
// Before this the planner ignored the log: lunch ideas were the same whether
// breakfast was porridge with milk or nothing at all. Now:
//
//   Food groups react fully. What is left of each group's daily serves is
//   spread over the meals with nothing logged yet, by the m5-03 meal pattern.
//
//   Energy reacts gently. An unlogged meal is planned at its usual size
//   times (what is left of the day / the usual size of the unlogged meals),
//   clamped to ENERGY_CLAMP. Without the floor a big breakfast would be
//   followed by a 200 kcal dinner that most plates cannot reach.
//
//   Meals already logged keep their usual targets, in case the user wants to
//   add more. When nothing is logged, every target is exactly what it was
//   before this file existed.
//
// Serves come only from catalogue rows (source 'catalog', external_id = the
// pool food's publicId), worked out from the row's TOTAL calories: grams =
// calories / kcal per 100 g * 100. That avoids the servings/nutrients
// ambiguity of m4-11. Barcode, FatSecret, manual and voice rows count their
// energy and ZERO serves: serves are minimums, so not knowing errs toward
// suggesting a little more of a group, which is the safe side.
import { and, eq } from "drizzle-orm";

import { mealLogsTable } from "../db/schema.js";
import { SERVE_GROUPS } from "./adgServeTargets.js";
import { mealServeTargets } from "./mealServePattern.js";

// P5, 2026-11-20: decision D4, an unlogged meal stays within 80-120% of its usual size.
export const ENERGY_CLAMP = Object.freeze({ min: 0.8, max: 1.2 });

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Today's rows for one user: one select. `db` is injected so tests can fake it
 * (like getAlcoholSummary in alcoholLogs.js).
 * @returns {Promise<Array<{ mealType: string, calories: number, externalId: string|null, source: string|null }>>}
 */
export const readTodayLogs = async ({ db, userId, dateStr }) =>
  db
    .select({
      mealType: mealLogsTable.mealType,
      calories: mealLogsTable.calories,
      externalId: mealLogsTable.externalId,
      source: mealLogsTable.source,
    })
    .from(mealLogsTable)
    .where(and(eq(mealLogsTable.userId, userId), eq(mealLogsTable.date, dateStr)));

/** publicId -> pool food, for summariseToday. */
export const indexPoolByPublicId = (pool = []) => new Map(pool.map((food) => [food.publicId, food]));

/** Row count and total energy: changes whenever a row is added, removed or resized. */
export const todayFingerprint = (logs = []) => {
  const kcal = logs.reduce((sum, row) => sum + (Number(row?.calories) || 0), 0);
  return `${logs.length}:${Math.round(kcal)}`;
};

/**
 * @param {object[]} logs           from readTodayLogs (camelCase or snake_case keys)
 * @param {Map<string, object>} poolByPublicId
 * @returns {{ eatenKcal: number, eatenServes: Record<string, number>, loggedMeals: Set<string>, fingerprint: string }}
 */
export const summariseToday = (logs = [], poolByPublicId = new Map()) => {
  let eatenKcal = 0;
  const eatenServes = Object.fromEntries(SERVE_GROUPS.map((g) => [g, 0]));
  const loggedMeals = new Set();
  for (const row of logs) {
    const kcal = Number(row?.calories) || 0;
    eatenKcal += kcal;
    const meal = String(row?.mealType ?? row?.meal_type ?? "").trim().toLowerCase();
    if (meal) loggedMeals.add(meal);
    const source = row?.source;
    const externalId = row?.externalId ?? row?.external_id;
    if (source !== "catalog" || !externalId) continue;
    const food = poolByPublicId.get(externalId);
    const per100 = Number(food?.per100g?.calories_kcal);
    if (!food || !(per100 > 0) || kcal <= 0) continue;
    const grams = (kcal / per100) * 100;
    for (const g of SERVE_GROUPS) eatenServes[g] += ((Number(food.serves100g?.[g]) || 0) * grams) / 100;
  }
  for (const g of SERVE_GROUPS) eatenServes[g] = round2(eatenServes[g]);
  return { eatenKcal: Math.round(eatenKcal), eatenServes, loggedMeals, fingerprint: todayFingerprint(logs) };
};

/**
 * Targets for the meals still to plan.
 *
 * @param {object} args
 * @param {Record<string, number>} args.mealKcal   the usual targets per meal (mealSplit.js), all slots planned
 * @param {object} args.dailyServes                 { vegetable, fruit, grain, protein, dairy } for the day
 * @param {{ eatenKcal: number, eatenServes: object }} args.eaten  from summariseToday
 * @param {Set<string>} args.loggedMeals
 * @param {number} [args.dailyKcal]                 the day's target; defaults to the sum of mealKcal
 * @returns {{ kcalByMeal: Record<string, number>, serveTargetsByMeal: object, adjustedMeals: string[], energyFactor: number|null }}
 *   energyFactor is the factor BEFORE ENERGY_CLAMP (T4, 2026-11-21), so a
 *   caller can tell when the 80% floor was hit; null when nothing was adjusted.
 */
export const adjustTargets = ({ mealKcal = {}, dailyServes = {}, eaten = {}, loggedMeals = new Set(), dailyKcal } = {}) => {
  const slots = Object.keys(mealKcal);
  const normalServes = mealServeTargets(dailyServes, { slots });
  const kcalByMeal = { ...mealKcal };
  const eatenKcal = Number(eaten.eatenKcal) || 0;
  const somethingLogged = loggedMeals.size > 0 || eatenKcal > 0;
  const unlogged = slots.filter((m) => !loggedMeals.has(m));
  if (!somethingLogged || unlogged.length === 0) {
    return { kcalByMeal, serveTargetsByMeal: normalServes, adjustedMeals: [], energyFactor: null };
  }

  const daily = Number.isFinite(Number(dailyKcal)) && Number(dailyKcal) > 0
    ? Number(dailyKcal)
    : slots.reduce((sum, m) => sum + (Number(mealKcal[m]) || 0), 0);
  const usualUnlogged = unlogged.reduce((sum, m) => sum + (Number(mealKcal[m]) || 0), 0);
  // T4, 2026-11-21 (m5-06): the unclamped factor is returned too, so plan
  // notes can say the day is already over its energy.
  const energyFactor = usualUnlogged > 0 ? (daily - eatenKcal) / usualUnlogged : null;
  const factor = energyFactor === null ? 1 : clamp(energyFactor, ENERGY_CLAMP.min, ENERGY_CLAMP.max);
  for (const m of unlogged) kcalByMeal[m] = Math.round((Number(mealKcal[m]) || 0) * factor);

  const left = Object.fromEntries(SERVE_GROUPS.map((g) => [
    g, Math.max(0, (Number(dailyServes?.[g]) || 0) - (Number(eaten.eatenServes?.[g]) || 0)),
  ]));
  const unloggedServes = mealServeTargets(left, { slots: unlogged });
  const serveTargetsByMeal = { ...normalServes, ...unloggedServes };
  return {
    kcalByMeal,
    serveTargetsByMeal,
    adjustedMeals: unlogged,
    energyFactor: energyFactor === null ? null : Math.round(energyFactor * 1000) / 1000,
  };
};
