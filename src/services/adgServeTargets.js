// Daily serve targets from the Australian Dietary Guidelines (checklist m4-04).
//
// The calorie target says how much energy in total. These say the MINIMUM
// number of serves from each of the five food groups. They depend only on
// age, sex and pregnancy/breastfeeding, never on the user's goal or a
// calorie goal: the guidelines define them for "average height with
// sedentary to moderate activity", and extra energy is met with ADDITIONAL
// serves on top (the `additionalMax` field), which is the planner's job
// (m5-03), not this file's.
//
// Source, copied 2026-11-16 from the two NHMRC Eat for Health tables:
//   eatforhealth.gov.au/food-essentials/how-much-do-we-need-each-day/
//     recommended-number-serves-adults
//     recommended-number-serves-children-adolescents-and-toddlers
// The app accepts ages 16 to 120, so the adolescent 14-18 rows are needed
// as well as the adult ones.
//
// Group keys match the food_adg_serves columns (grain_serves, ...) so a plan
// can be scored by summing those columns and comparing against these.
//
// Pure: no database, no clock. The caller passes the age. That keeps it
// testable and lets dailyCalorieTarget.js own the one age calculation.

import { applyLifeStage, resolveLifeStage } from "./lifeStage.js";

export const SERVE_GROUPS = Object.freeze(["vegetable", "fruit", "grain", "protein", "dairy"]);

// [vegetable, fruit, grain, protein, dairy, additionalMax]
// additionalMax is the top of the guidelines' "approx. number of additional
// serves" range (the bottom is always 0).
const row = (vegetable, fruit, grain, protein, dairy, additionalMax) =>
  Object.freeze({ vegetable, fruit, grain, protein, dairy, additionalMax });

export const ADG_SERVE_TABLE = Object.freeze({
  male_14_18: row(5.5, 2, 7, 2.5, 3.5, 5),
  female_14_18: row(5, 2, 7, 2.5, 3.5, 2.5),
  pregnant_14_18: row(5, 2, 8, 3.5, 3.5, 3),
  lactating_14_18: row(5.5, 2, 9, 2.5, 4, 3),

  male_19_50: row(6, 2, 6, 3, 2.5, 3),
  male_51_70: row(5.5, 2, 6, 2.5, 2.5, 2.5),
  male_70_plus: row(5, 2, 4.5, 2.5, 3.5, 2.5),

  female_19_50: row(5, 2, 6, 2.5, 2.5, 2.5),
  female_51_70: row(5, 2, 4, 2, 4, 2.5),
  female_70_plus: row(5, 2, 3, 2, 4, 2),

  pregnant_19_plus: row(5, 2, 8.5, 3.5, 2.5, 2.5),
  lactating_19_plus: row(7.5, 2, 9, 2.5, 2.5, 2.5),
});

const FIELDS = [...SERVE_GROUPS, "additionalMax"];

// The guidelines count in half serves, so derived rows do too. Rounds a
// quarter UP (2.75 -> 3) so a derived target is never below the midpoint.
const toHalfServe = (value) => Math.ceil(value * 2 - 1e-9) / 2;

/**
 * The daily serve targets for one person.
 *
 * Which row applies, including the three cases the guidelines have no row
 * for (gender Other, pregnant AND breastfeeding, pregnant aged 51+), is
 * decided in lifeStage.js, shared with the water target so the two can never
 * describe different people. This file only supplies the table and the
 * half-serve rounding.
 *
 * @param {object} p
 * @param {number} p.age              whole years; 0 or missing = unknown
 * @param {string|null} p.gender      'male' | 'female' | 'other' | null
 * @param {boolean|null} p.isPregnant
 * @param {boolean|null} p.isBreastfeeding
 * @returns {{vegetable:number, fruit:number, grain:number, protein:number,
 *            dairy:number, additionalMax:number, row:string, source:string}}
 */
export const resolveServeTargets = (person = {}) => {
  const stage = resolveLifeStage(person);
  return {
    ...applyLifeStage(ADG_SERVE_TABLE, stage, FIELDS, toHalfServe),
    row: stage.row,
    source: stage.source === "known" ? "adg" : "adg_default",
  };
};
