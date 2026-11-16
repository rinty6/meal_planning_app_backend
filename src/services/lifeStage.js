// Which row of an Australian reference table applies to a person.
//
// NHMRC tables (the ADG serve table, the NRV water table, and later others)
// are all laid out the same way: rows by sex and age band, plus separate
// pregnancy and lactation rows. They all leave the same three cases without a
// row, and the app must answer those the SAME way for every table, or a
// user's serve targets and water target would describe two different people.
// So the answers live here, once (decided 2026-11-16):
//
//   Gender "other" or unknown  midpoint of the male and female rows
//   Pregnant AND breastfeeding the larger of the two rows, field by field
//   Pregnant aged 51+          the adult pregnancy row
//
// Pregnancy is ignored for a male user, matching demographicsRules.js, which
// never stores it for one.
//
// Row keys follow one naming scheme, which every table using this must have:
//   {male|female}_{14_18|19_50|51_70|70_plus}
//   {pregnant|lactating}_{14_18|19_plus}
// A table whose values do not change across the adult bands simply repeats
// them; that is cheaper than a second naming scheme.

/**
 * Which age band applies. Ages below 19 use 14-18: the app's minimum is 16.
 * An unknown age (0 or missing) uses the adult 19-50 band. "70+" follows
 * "51-70" in the tables, so it starts at 71.
 */
export const ageBand = (age) => {
  if (!Number.isFinite(age) || age <= 0) return "19_50";
  if (age < 19) return "14_18";
  if (age <= 50) return "19_50";
  if (age <= 70) return "51_70";
  return "70_plus";
};

/**
 * Decide which row(s) apply.
 *
 * @returns {{ mode: "row" | "max" | "midpoint", keys: string[], row: string, source: string }}
 *   mode "row":      use keys[0]
 *   mode "max":      larger of keys[0] and keys[1], field by field
 *   mode "midpoint": average of keys[0] (male) and keys[1] (female)
 *   row:             a readable label for logs and tests
 *   source:          "known" when age and gender were both known, else "default"
 */
export const resolveLifeStage = ({ age, gender, isPregnant, isBreastfeeding } = {}) => {
  const band = ageBand(age);
  const sex = String(gender ?? "").toLowerCase();
  const ageKnown = Number.isFinite(age) && age > 0;
  const genderKnown = sex === "male" || sex === "female" || sex === "other";
  const source = ageKnown && genderKnown ? "known" : "default";

  if (sex !== "male" && (isPregnant === true || isBreastfeeding === true)) {
    const stage = band === "14_18" ? "14_18" : "19_plus";
    if (isPregnant === true && isBreastfeeding === true) {
      const keys = [`pregnant_${stage}`, `lactating_${stage}`];
      return { mode: "max", keys, row: `max(${keys.join(",")})`, source };
    }
    const key = isPregnant === true ? `pregnant_${stage}` : `lactating_${stage}`;
    return { mode: "row", keys: [key], row: key, source };
  }

  if (sex === "male" || sex === "female") {
    const key = `${sex}_${band}`;
    return { mode: "row", keys: [key], row: key, source };
  }

  const keys = [`male_${band}`, `female_${band}`];
  return { mode: "midpoint", keys, row: `midpoint(${keys.join(",")})`, source };
};

/**
 * Apply a resolved life stage to one table.
 *
 * @param {object} table       rows keyed as described above
 * @param {object} stage       from resolveLifeStage
 * @param {string[]} fields    which fields of a row to return
 * @param {(n:number)=>number} roundMidpoint  how a table rounds a midpoint
 *        (half serves for the ADG, 50 mL for water)
 */
export const applyLifeStage = (table, stage, fields, roundMidpoint) => {
  const rows = stage.keys.map((key) => {
    const found = table[key];
    if (!found) throw new Error(`life-stage table is missing row "${key}"`);
    return found;
  });
  const out = {};
  for (const field of fields) {
    if (stage.mode === "row") out[field] = rows[0][field];
    else if (stage.mode === "max") out[field] = Math.max(rows[0][field], rows[1][field]);
    else out[field] = roundMidpoint((rows[0][field] + rows[1][field]) / 2);
  }
  return out;
};
