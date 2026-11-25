// The day's fluids against the NRV target (checklist m6-02,
// WATER_TOTAL_DESIGN.html, decided 2026-11-25: D1 Home + Meal Summary,
// D2 own table, D3 what counts, D4 250 ml per tap).
//
// The total is glasses from the water row (water_logs) plus drinks logged as
// foods (meal_logs). What counts, from the design's section 4:
//   - every glass: its ml;
//   - catalogue drinks with a known size: water, tea, coffee, milk, juice,
//     soft drinks. AUSNUT foods by sub-major group (food_ausnut_<code>, the
//     first three digits); branded Open Food Facts foods (food_off_<barcode>)
//     carry no group, so only when their serving is written in ml or L;
//   - NOT alcohol (it has its own standard-drink budget, m6-04);
//   - NOT food water (soup, yoghurt, fruit): the NRV fluids figure leaves it out;
//   - NOT FatSecret, manual, voice or recognition rows: no size is stored, so
//     any figure would be a guess. Nothing on screen says so (user: as little
//     text as possible).
import { and, asc, desc, eq } from "drizzle-orm";

import { mealLogsTable, waterLogsTable } from "../db/schema.js";

// D4: one tap is one 250 ml glass.
export const GLASS_ML = 250;
// A single request may add at most this much, so a bad client cannot log 50 L.
export const MAX_WATER_ML = 2000;

// AUSNUT 2023 sub-major groups that are drinks: 111 tea, 112 coffee, 113 juice,
// 114 fruit drinks, 115 cordials, 116 soft drinks, 117 electrolyte/energy,
// 118 waters, 119 prepared beverages, 191 dairy milk, 201 milk substitutes.
const DRINK_GROUPS = new Set(["111", "112", "113", "114", "115", "116", "117", "118", "119", "191", "201"]);
// Inside those groups, the things nobody drinks as they are: dry tea, coffee
// powder, beverage bases, concentrates, whitener, evaporated/condensed milk.
// "mix powder" only in the name's first part: "Coffee mix powder, ..." is a
// powder, "Chai latte, made with chai mix powder & milk" is a drink.
const NOT_A_DRINK = /^beverage base|^cocoa powder|whitener|^[^,]*(mix powder|substitute mix)|evaporated|condensed/i;
const NOT_A_DRINK_SEGMENT = /^(dry|dry powder|powder|undiluted)$|\b(concentrate|essence)$/i;
// A row with more alcohol than this is an alcoholic drink (1 g in a 250 ml
// glass is 0.5% ABV, the Australian "non-alcoholic" line).
const ALCOHOL_G_LIMIT = 1;

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** The AUSNUT sub-major group of a catalogue id, or null. */
export const ausnutGroupOf = (externalId) => {
  const match = /^food_ausnut_(\d{3})\d*$/.exec(String(externalId ?? ""));
  return match ? match[1] : null;
};

/** True when the AUSNUT food name is something you drink as it is. */
export const isDrinkName = (name = "") => {
  const text = String(name).trim();
  if (!text || NOT_A_DRINK.test(text)) return false;
  return !text.split(",").some((segment) => NOT_A_DRINK_SEGMENT.test(segment.trim()));
};

const FRACTIONS = { "½": 0.5, "¼": 0.25, "¾": 0.75 };
/** "1½ × 1 bottle (300 ml)" -> 1.5; no "N ×" prefix -> 1. */
const multiplierOf = (description = "") => {
  const match = /^\s*(\d+)?\s*([½¼¾])?\s*[×x]\s/.exec(String(description));
  if (!match || (!match[1] && !match[2])) return 1;
  return (Number(match[1]) || 0) + (FRACTIONS[match[2]] || 0);
};

/** Millilitres written in a serving description ("(250 ml)", "1.25 L"), or null. */
export const descriptionMl = (description = "") => {
  const text = String(description);
  const ml = text.match(/(\d+(?:\.\d+)?)\s*ml\b/i);
  if (ml) return Number(ml[1]);
  const litres = text.match(/(\d+(?:\.\d+)?)\s*l\b/i);
  return litres ? Number(litres[1]) * 1000 : null;
};

/**
 * Millilitres of fluid in one meal_logs row, or 0 when it does not count.
 * @param {{ source?: string, externalId?: string, foodName?: string, servingDescription?: string, servings?: number, nutrients?: object }} log
 */
export const drinkMlForLog = (log = {}) => {
  if (log?.source !== "catalog") return 0;
  const alcohol = toNumber(log?.nutrients?.alcohol_g);
  if (alcohol !== null && alcohol > ALCOHOL_G_LIMIT) return 0;

  const externalId = String(log?.externalId ?? log?.external_id ?? "");
  const description = log?.servingDescription ?? log?.serving_description ?? "";
  const servings = toNumber(log?.servings) ?? 1;
  const statedMl = descriptionMl(description);
  const group = ausnutGroupOf(externalId);

  if (group) {
    if (!DRINK_GROUPS.has(group) || !isDrinkName(log?.foodName ?? log?.food_name)) return 0;
    // serving_grams is ONE serving with any "1½ ×" already applied (plate logs).
    // A stated size in ml beats grams (milk is 1.04 g/ml).
    const volume = statedMl !== null
      ? statedMl * multiplierOf(description)
      : toNumber(log?.nutrients?.serving_grams);
    return volume && volume > 0 ? Math.round(volume * servings) : 0;
  }
  // Branded (Open Food Facts) foods have no group: only a serving in ml counts.
  if (/^food_off_/.test(externalId) && statedMl !== null) {
    return Math.round(statedMl * multiplierOf(description) * servings);
  }
  return 0;
};

/**
 * @param {object} args
 * @param {Array<{ id: number, ml: number }>} args.glasses   water_logs rows, oldest first
 * @param {object[]} args.logs                                meal_logs rows for the day
 * @param {number} args.targetMl
 */
export const summariseWater = ({ glasses = [], logs = [], targetMl = 0 } = {}) => {
  const glassesMl = glasses.reduce((sum, g) => sum + (Number(g?.ml) || 0), 0);
  const drinksMl = logs.reduce((sum, row) => sum + drinkMlForLog(row), 0);
  const last = glasses.length ? glasses[glasses.length - 1] : null;
  return {
    targetMl: Math.max(0, Math.round(Number(targetMl) || 0)),
    totalMl: glassesMl + drinksMl,
    glassesMl,
    drinksMl,
    // The minus button takes back the last glass only, never a logged coffee.
    lastGlassId: last ? last.id : null,
  };
};

/** One day for one user: the body of GET /api/water/:clerkId. */
export const readWaterDay = async ({ db, userId, dateStr, targetMl }) => {
  const [glasses, logs] = await Promise.all([
    db
      .select({ id: waterLogsTable.id, ml: waterLogsTable.ml })
      .from(waterLogsTable)
      .where(and(eq(waterLogsTable.userId, userId), eq(waterLogsTable.date, dateStr)))
      .orderBy(asc(waterLogsTable.createdAt), asc(waterLogsTable.id)),
    db
      .select({
        source: mealLogsTable.source,
        externalId: mealLogsTable.externalId,
        foodName: mealLogsTable.foodName,
        servingDescription: mealLogsTable.servingDescription,
        servings: mealLogsTable.servings,
        nutrients: mealLogsTable.nutrients,
      })
      .from(mealLogsTable)
      .where(and(eq(mealLogsTable.userId, userId), eq(mealLogsTable.date, dateStr))),
  ]);
  return { date: dateStr, ...summariseWater({ glasses, logs, targetMl }) };
};

/** The newest glass of the day, for the minus button. */
export const findLastGlass = async ({ db, userId, dateStr }) => {
  const [row] = await db
    .select({ id: waterLogsTable.id })
    .from(waterLogsTable)
    .where(and(eq(waterLogsTable.userId, userId), eq(waterLogsTable.date, dateStr)))
    .orderBy(desc(waterLogsTable.createdAt), desc(waterLogsTable.id))
    .limit(1);
  return row || null;
};
