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

const combine = (left, right, pick) => {
  const out = {};
  for (const field of FIELDS) out[field] = pick(left[field], right[field]);
  return Object.freeze(out);
};

/**
 * Which age band of the table applies. Ages below 19 use 14-18: the app's
 * minimum is 16, and an unknown age (0) falls into the adult band instead.
 * "70+" in the guidelines follows "51-70", so it starts at 71.
 */
const ageBand = (age) => {
  if (!Number.isFinite(age) || age <= 0) return "19_50";
  if (age < 19) return "14_18";
  if (age <= 50) return "19_50";
  if (age <= 70) return "51_70";
  return "70_plus";
};

/**
 * The daily serve targets for one person.
 *
 * Rules where the guidelines have no row (decided 2026-11-16):
 *   Gender "other" or unknown  midpoint of the male and female rows for that
 *                              age, rounded up to the half serve. Matches the
 *                              calorie formula, which also uses the midpoint.
 *   Pregnant AND breastfeeding the larger of the two rows, group by group, so
 *                              neither need is under-served.
 *   Pregnant aged 51+          the adult pregnant row (pregnancy rows are only
 *                              split into "up to 18" and "19 and over").
 *
 * Pregnancy is ignored for a male user, matching demographicsRules.js, which
 * never stores it for one in the first place.
 *
 * @param {object} p
 * @param {number} p.age              whole years; 0 or missing = unknown
 * @param {string|null} p.gender      'male' | 'female' | 'other' | null
 * @param {boolean|null} p.isPregnant
 * @param {boolean|null} p.isBreastfeeding
 * @returns {{vegetable:number, fruit:number, grain:number, protein:number,
 *            dairy:number, additionalMax:number, row:string, source:string}}
 */
export const resolveServeTargets = ({ age, gender, isPregnant, isBreastfeeding } = {}) => {
  const band = ageBand(age);
  const sex = String(gender ?? "").toLowerCase();
  const ageKnown = Number.isFinite(age) && age > 0;
  const genderKnown = sex === "male" || sex === "female" || sex === "other";
  const source = ageKnown && genderKnown ? "adg" : "adg_default";

  if (sex !== "male" && (isPregnant === true || isBreastfeeding === true)) {
    const lifeStage = band === "14_18" ? "14_18" : "19_plus";
    const pregnant = ADG_SERVE_TABLE[`pregnant_${lifeStage}`];
    const lactating = ADG_SERVE_TABLE[`lactating_${lifeStage}`];

    if (isPregnant === true && isBreastfeeding === true) {
      return {
        ...combine(pregnant, lactating, Math.max),
        row: `max(pregnant_${lifeStage},lactating_${lifeStage})`,
        source,
      };
    }
    const key = isPregnant === true ? `pregnant_${lifeStage}` : `lactating_${lifeStage}`;
    return { ...ADG_SERVE_TABLE[key], row: key, source };
  }

  if (sex === "male" || sex === "female") {
    const key = `${sex}_${band}`;
    return { ...ADG_SERVE_TABLE[key], row: key, source };
  }

  const male = ADG_SERVE_TABLE[`male_${band}`];
  const female = ADG_SERVE_TABLE[`female_${band}`];
  return {
    ...combine(male, female, (m, f) => toHalfServe((m + f) / 2)),
    row: `midpoint(male_${band},female_${band})`,
    source,
  };
};
