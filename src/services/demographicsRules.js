// The rules for what may be stored in `demographics`, in ONE place.
//
// Two routes write this table: the onboarding save (routes/demographics.js)
// and the profile edit (routes/profile.js). Before this file existed each had
// its own idea of what was valid, and neither validated activityLevel at all,
// so a value the database's enum rejects came back as a 500 instead of a 400.
// Both routes now call these functions, so a rule changed here changes for
// both, and they cannot drift apart.
//
// Design for the pregnancy fields:
//   claude_memory/database redesign/meal planning redesign/
//     ONBOARDING_PREGNANCY_DESIGN.html
//
// The app's half of the pregnancy rule (WHO is shown the question: Female
// and Other) is meal_app/utils/pregnancyQuestion.ts. That is a separate repo
// and cannot import this file, so if the rule changes, change both.
import { ACTIVITY_LEVELS } from "./dailyCalorieTarget.js";

export { ACTIVITY_LEVELS };

/** True when `value` is one of the activity levels the database accepts. */
export const isValidActivityLevel = (value) =>
  typeof value === "string" && ACTIVITY_LEVELS.includes(value);

/**
 * One request value -> the three states the column can hold, plus "not sent".
 *
 *   true  / "true"    -> true    answered, applies
 *   false / "false"   -> false   answered, does not apply
 *   null              -> null    not stated (the step was skipped)
 *   undefined         -> undefined  NOT SENT: leave the stored value alone
 *
 * The undefined/null split matters because Drizzle leaves an undefined field
 * out of an UPDATE entirely but writes a null (checked 2026-11-15). So a
 * profile save that does not mention pregnancy cannot accidentally wipe it,
 * while a save that sends null deliberately clears it.
 *
 * Anything else ("yes", 1, {}) is treated as not sent rather than guessed at.
 */
export const toTriState = (value) => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  if (value === null) return null;
  return undefined;
};

/**
 * The pregnancy fields to store, given the gender they will be stored against.
 *
 * A male user is ALWAYS stored as NULL, NULL, whatever the request says. The
 * app hides the question for male users and clears the answers if someone
 * changes step 3 to Male, but the server enforces it as well, so that a stale
 * client, a future screen, or a bug cannot leave `is_pregnant = true` on a man.
 * That would be wrong data and would silently remove alcohol from his plan with
 * no screen anywhere explaining why.
 *
 * `gender` must be the gender being SAVED: the new value if this request
 * changes it, otherwise the stored one. Passing the old gender when the
 * request changes it to male is exactly the hole this guards.
 *
 * @param {object} p
 * @param {string|null|undefined} p.gender
 * @param {*} p.isPregnant       raw request value
 * @param {*} p.isBreastfeeding  raw request value
 * @param {boolean} p.skippedMeansNull  onboarding: true (a skipped step is a
 *        statement, store NULL). profile edit: false (not sent = unchanged).
 */
export const resolvePregnancyFields = ({
  gender,
  isPregnant,
  isBreastfeeding,
  skippedMeansNull,
}) => {
  if (String(gender ?? "").toLowerCase() === "male") {
    return { isPregnant: null, isBreastfeeding: null };
  }
  let pregnant = toTriState(isPregnant);
  let feeding = toTriState(isBreastfeeding);
  if (skippedMeansNull) {
    if (pregnant === undefined) pregnant = null;
    if (feeding === undefined) feeding = null;
  }
  return { isPregnant: pregnant, isBreastfeeding: feeding };
};
