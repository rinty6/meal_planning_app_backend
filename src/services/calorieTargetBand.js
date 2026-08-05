// SINGLE DEFINITION OF "DID THE USER HIT THEIR CALORIE TARGET?"
//
// Before this existed, the answer was `total >= target` for "reached" and
// `total > target` for "exceeded". Those overlap: one calorie over set BOTH,
// and because the app tested "exceeded" first, the congratulation was
// unreachable unless the user landed on the target to the calorie. See
// ERROR_LOG Error 074.
//
// Why a band, and why 10%:
//   - The target itself is a Mifflin-St Jeor estimate (services/dailyCalorieTarget.js),
//     which lands within roughly 10% of true energy needs on average. Demanding an
//     exact hit claims a precision the number never had.
//   - Measured day-to-day energy intake varies by roughly +/-25%, and outcome
//     research points at weekly consistency over daily precision. +/-10% is tight.
//   - It matches how coaching platforms model compliance (a configurable variance
//     around the goal).
//
// Symmetric by product decision (2026-08-05): slightly under and slightly over
// are treated as equally on-target.

export const CALORIE_TARGET_TOLERANCE = 0.1;

/** @typedef {"under" | "on_target" | "over"} CalorieZone */

export const getCalorieTargetBand = (target) => {
  const safeTarget = Number(target) > 0 ? Number(target) : 0;
  return {
    lower: safeTarget * (1 - CALORIE_TARGET_TOLERANCE),
    upper: safeTarget * (1 + CALORIE_TARGET_TOLERANCE),
  };
};

/**
 * @param {number} total consumed calories so far today
 * @param {number} target the user's daily calorie target
 * @returns {CalorieZone}
 */
export const resolveCalorieZone = (total, target) => {
  const safeTarget = Number(target) > 0 ? Number(target) : 0;
  // With no usable target every total is "still going" — never celebrate or warn
  // off a target we do not actually have (the Error 066 lesson).
  if (!safeTarget) return "under";

  const consumed = Number(total) > 0 ? Number(total) : 0;
  const { lower, upper } = getCalorieTargetBand(safeTarget);

  if (consumed < lower) return "under";
  if (consumed > upper) return "over";
  return "on_target";
};
