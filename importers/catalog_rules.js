/**
 * Shared plausibility rules for the catalogue.
 *
 * catalog_audit.js REPORTS violations, catalog_quarantine.js RETIRES them.
 * They must never disagree about what "bad" means, so the predicates live here
 * once and both import them. If these ever drifted apart, the audit could come
 * back green while impossible rows stayed active in search.
 *
 * Every predicate is written against the aliases used by both callers:
 *   f = catalog_foods, s = catalog_food_servings, p = nutrition_profiles
 * and is evaluated on the DEFAULT serving only. Other servings are linear
 * scalings of the same per-100 g figures, so they cannot disagree.
 */
import { sql } from 'drizzle-orm';

/**
 * Per-100 g normalisation. Profiles are stored per serving with basis_quantity
 * holding that serving's grams, so every comparison divides it back out.
 */
export const per100 = (col) => sql`(${sql.raw(col)}::float8 * 100.0 / p.basis_quantity::float8)`;

/**
 * Protein + fat + available carbohydrate + fibre cannot exceed 100 g per 100 g.
 * Composition tables measure each fraction independently, so sums land slightly
 * over on dry foods. Calibrated against the real distribution 2026-09-03:
 * AUSNUT's worst is 104.0 g and 3,731 of 3,741 sit at or under 100, so
 * 100.5-105 is analytical noise. Past 105 is a wrong number.
 */
export const MASS_NOTE_G = 100.5;
export const MASS_FAIL_G = 105;

/**
 * `quarantine: true` means a violation is a deterministic physical
 * impossibility and the food should be retired. `false` means the check is
 * advisory: it flags rows worth a human look but is not safe to automate.
 */
export const PLAUSIBILITY_RULES = [
  {
    key: 'mass_budget',
    label: `macros do not exceed ${MASS_FAIL_G} g per 100 g`,
    quarantine: true,
    predicate: sql`${per100('p.protein_g')} + ${per100('p.fat_g')}
      + ${per100('p.carbohydrate_g')} + ${per100('coalesce(p.fiber_g,0)')} > ${MASS_FAIL_G}`,
  },
  {
    key: 'fat_fractions',
    label: 'saturated + mono + poly does not exceed total fat',
    quarantine: true,
    predicate: sql`${per100('coalesce(p.saturated_fat_g,0)')} + ${per100('coalesce(p.monounsaturated_fat_g,0)')}
      + ${per100('coalesce(p.polyunsaturated_fat_g,0)')} > ${per100('p.fat_g')} + 0.5`,
  },
  {
    key: 'sugar_vs_carb',
    label: 'sugar does not exceed carbohydrate',
    quarantine: true,
    predicate: sql`${per100('p.sugar_g')} > ${per100('p.carbohydrate_g')} + 0.5`,
  },
  {
    key: 'sat_vs_fat',
    label: 'saturated fat does not exceed total fat',
    quarantine: true,
    predicate: sql`${per100('p.saturated_fat_g')} > ${per100('p.fat_g')} + 0.5`,
  },
  {
    key: 'trans_vs_fat',
    label: 'trans fat does not exceed total fat',
    quarantine: true,
    predicate: sql`${per100('p.trans_fat_g')} > ${per100('p.fat_g')} + 0.5`,
  },
  {
    // Advisory. Physically exact - NaCl is 39.34% sodium, so X mg of sodium
    // implies at least X x 2.542 mg of salt, and that mass competes with the
    // macros for the same 100 g. It is NOT auto-quarantined because 1 AUSNUT
    // row trips it ("Seasoning, all purpose, dry powder", 78.9 g macros +
    // 39.3 g salt), and a rule that flags the lab-measured backbone needs a
    // human before it retires anything. Caught real errors on first run:
    // "Basmati Rice" at 14,286 mg sodium, almond butter at 9,439.
    key: 'mass_budget_with_salt',
    label: `macros + salt equivalent do not exceed ${MASS_FAIL_G} g per 100 g`,
    quarantine: false,
    predicate: sql`${per100('p.protein_g')} + ${per100('p.fat_g')}
      + ${per100('p.carbohydrate_g')} + ${per100('coalesce(p.fiber_g,0)')}
      + ${per100('p.sodium_mg')} * 2.542 / 1000.0 > ${MASS_FAIL_G}`,
  },
  {
    // Advisory. Above ~5,000 mg per 100 g a food is essentially a salt-based
    // condiment, and legitimate ones exist (soy sauce, stock powder, yeast
    // extract, sodium saccharin), so this cannot be automated on a name list.
    // It is here because p3-04 found Coca-Cola stored at 10,000 mg per 100 mL
    // against a real ~10 mg - a 1000x unit error that passes every other rule,
    // since sodium is not part of the macro mass budget and 10,000 sits well
    // under the salt ceiling.
    key: 'sodium_implausible',
    label: 'sodium below 5,000 mg per 100 g (condiment territory)',
    quarantine: false,
    predicate: sql`${per100('p.sodium_mg')} > 5000`,
  },
  {
    // Advisory, not automated. Pure NaCl is 39,300 mg sodium per 100 g, so
    // anything above it is impossible — but every observed violation sits at
    // exactly 40,000, which is 1.8% over and reads as label rounding on a
    // genuine salt product rather than a data error. Retiring real salt over a
    // rounding artifact would be worse than leaving it. The one true error in
    // the set (a soft drink at 40,000) is a single row; handle it by hand.
    key: 'sodium_ceiling',
    label: 'sodium below pure salt (39,300 mg per 100 g)',
    quarantine: false,
    predicate: sql`${per100('p.sodium_mg')} > 39300`,
  },
  {
    key: 'kj_kcal_agree',
    label: 'energy_kj and calories_kcal agree (kJ = kcal x 4.184)',
    quarantine: true,
    predicate: sql`abs(p.energy_kj::float8 - p.calories_kcal::float8 * 4.184)
      > greatest(p.energy_kj::float8 * 0.01, 1)`,
  },
];

/** The subset that catalog_quarantine.js is allowed to act on. */
export const QUARANTINE_RULES = PLAUSIBILITY_RULES.filter((r) => r.quarantine);

/** `a OR b OR c` across a set of rules, for a single-pass query. */
export const anyViolation = (rules) =>
  rules.map((r) => sql`(${r.predicate})`).reduce((acc, p) => sql`${acc} OR ${p}`);

/**
 * The join every rule is evaluated over: one row per food, its default serving.
 * `activeOnly` is what separates "still a problem" from "already retired".
 */
export const defaultServingJoin = (activeOnly) => sql`
  from catalog_foods f
  join catalog_food_servings s on s.food_id = f.id and s.is_default
  join nutrition_profiles p on p.id = s.nutrition_profile_id
  where p.basis_quantity > 0 ${activeOnly ? sql`and f.is_active` : sql``}`;
