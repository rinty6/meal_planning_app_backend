// Stored nutrients follow a Meal Summary +/- (checklist m4-11, task T1,
// 2026-11-21).
//
// meal_logs.nutrients holds TOTALS for the row's servings at log time.
// PUT /api/meals/update/:id rewrote servings, calories and macros but left
// nutrients alone, so after a +/- every nutrient (fibre, sodium, alcohol_g...)
// still described the old servings. The alcohol screen (m6-04) reads
// alcohol_g, so this must hold before it ships.

// T1, 2026-11-21: serving_grams is the size of ONE serving, not a total, so a
// change of servings never scales it.
const NOT_SCALED = new Set(["serving_grams"]);

const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Nutrients for newServings, from nutrients stored for oldServings.
 * Finite numbers scale; null stays null; strings (vitamin_a_convention) and
 * other values are kept as they are. A bad or zero oldServings returns the
 * nutrients unchanged: nothing to scale from.
 *
 * @param {object|null} nutrients
 * @param {number} oldServings
 * @param {number} newServings
 * @returns {object|null}
 */
export const scaleNutrients = (nutrients, oldServings, newServings) => {
  if (!nutrients || typeof nutrients !== "object" || Array.isArray(nutrients)) return nutrients;
  const from = Number(oldServings);
  const to = Number(newServings);
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) return nutrients;
  const factor = to / from;
  const out = {};
  for (const [key, value] of Object.entries(nutrients)) {
    out[key] = typeof value === "number" && Number.isFinite(value) && !NOT_SCALED.has(key)
      ? round3(value * factor)
      : value;
  }
  return out;
};
