// The meal types a log can have (checklist m4-09). This is the ONE list.
// Every service and route that sorts, groups or filters logs by meal type
// reads it from here, so a new type is one edit.
//
// Order matters: breakfast, lunch, dinner, snack. Snack is last because it
// can happen at any time of day, and this matches the split order in
// mealSplit.js.
//
// Snack is never EXPECTED. Nothing may read a day without a snack as a gap,
// a skip or a reminder trigger.
//
// Three-meal copies that remain elsewhere on purpose:
//   - routes/recommendation/ is the frozen old ML path.
//   - routes/mealPlan.js keeps the planner's three slots until m5-04.
//   - config/cron.js skip checks cover the three expected meals only.

export const MEAL_TYPES = Object.freeze(["breakfast", "lunch", "dinner", "snack"]);

/** True when `value` is one of MEAL_TYPES, ignoring case and outer spaces. */
export const isMealType = (value) =>
  typeof value === "string" && MEAL_TYPES.includes(value.trim().toLowerCase());
