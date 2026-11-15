// The one place allergen and diet preferences turn into a food filter.
//
// Phase A1 of the meal-planning redesign published 97,266 rows into
// food_attributes: 24 allergens x 3,741 generic foods, plus vegetarian and
// vegan. Before that the planner matched words in food titles, which was
// measured on 2026-11-12 to miss 31 of the 227 foods in the Milk group,
// including "Custard, dairy, vanilla, commercial", because the keyword list
// had no entry for "dairy".
//
// This module exists on its own, ahead of the planner change that will use it
// (m5-01), because it is the single place the two rules below can be got
// wrong, and it is provable against live data without any planner code.
//
// ---------------------------------------------------------------------------
// RULE 1 — UNKNOWN IS NEVER TREATED AS FREE.
//
//   food_attributes.value is a tri-state the schema already defined:
//       1 contains / is      0 free / is not      -1 unknown
//
//   About half of all allergen verdicts are -1, concentrated in the commercial
//   and takeaway composed foods AUSNUT never formulated. Failing closed costs
//   a user variety. Failing open can hurt them.
//
// RULE 2 — A MISSING ROW IS UNKNOWN, NOT FREE.
//
//   The stricter corollary, and the one that bites. Only the 3,741 GENERIC
//   foods have been classified. The 46,002 branded products have NO rows at
//   all. A filter written as "exclude where value = 1" would silently pass
//   every branded food to an allergic user. Strict mode therefore requires a
//   positive `free` row to exist, rather than merely requiring the absence of
//   a `contains` row.
// ---------------------------------------------------------------------------
//
// STRICTNESS IS PER ALLERGEN, not per user. Someone can be anaphylactic to
// peanut and merely avoiding lactose; one global switch forces them to set the
// wrong level for one of the two, and they will set it to flexible.
//
//   strict    (default)  only `free` passes
//   flexible             `free` and `unknown` pass, and every unknown MUST be
//                        rendered with a "may contain" flag. An unflagged
//                        unknown is indistinguishable from a verified free
//                        food, which is the failure this design exists to
//                        prevent. Callers get that list from
//                        `flaggedAllergensFor` and are responsible for showing
//                        it.
//
// `contains` never passes, in either mode.
import { sql } from "drizzle-orm";

/** The 24 FSANZ-derived allergen slugs, as published by tools/food_classify. */
export const ALLERGEN_SLUGS = Object.freeze([
  "wheat", "barley", "oats", "rye",
  "egg", "milk", "fish", "crustacean", "mollusc",
  "peanut", "soy", "sesame", "lupin", "sulphites",
  "almond", "brazil-nut", "cashew", "hazelnut", "macadamia",
  "pecan", "pistachio", "pine-nut", "walnut",
  "lactose",
]);

export const DIET_SLUGS = Object.freeze(["vegetarian", "vegan"]);

/** Coarse groups the UI may collapse to. Data stays at the FSANZ grain. */
export const ALLERGEN_GROUPS = Object.freeze({
  gluten: ["wheat", "barley", "oats", "rye"],
  shellfish: ["crustacean", "mollusc"],
  treenut: ["almond", "brazil-nut", "cashew", "hazelnut", "macadamia",
            "pecan", "pistachio", "pine-nut", "walnut"],
});

export const STRICT = "strict";
export const FLEXIBLE = "flexible";

const VALUE = Object.freeze({ IS: 1, IS_NOT: 0, UNKNOWN: -1 });

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/**
 * Expand any coarse group names the UI sent into the underlying slugs, drop
 * anything unrecognised, and de-duplicate.
 *
 * Unrecognised input is dropped rather than throwing, because a typo must not
 * take the planner down. It is returned in `ignored` so a caller can log it:
 * silently discarding an allergen the user asked for would be the worst
 * possible failure here.
 */
export const normalizeAllergens = (input) => {
  const out = new Set();
  const ignored = [];
  for (const raw of asArray(input)) {
    const key = String(raw ?? "").trim().toLowerCase();
    if (!key) continue;
    if (ALLERGEN_GROUPS[key]) {
      for (const slug of ALLERGEN_GROUPS[key]) out.add(slug);
    } else if (ALLERGEN_SLUGS.includes(key)) {
      out.add(key);
    } else {
      ignored.push(raw);
    }
  }
  return { slugs: [...out], ignored };
};

export const normalizeDiets = (input) => {
  const out = new Set();
  const ignored = [];
  for (const raw of asArray(input)) {
    const key = String(raw ?? "").trim().toLowerCase();
    if (!key) continue;
    if (DIET_SLUGS.includes(key)) out.add(key);
    else ignored.push(raw);
  }
  return { slugs: [...out], ignored };
};

/** The mode for one slug: an explicit entry, else the default, else strict. */
export const modeFor = (slug, strictness = {}, fallback = STRICT) => {
  const m = String(strictness?.[slug] ?? fallback).toLowerCase();
  return m === FLEXIBLE ? FLEXIBLE : STRICT;
};

/**
 * SQL predicates to AND into a candidate query, against a catalog_foods alias.
 *
 * Returns one fragment per allergen and per diet. Both shapes deliberately
 * differ, and the difference IS rule 2:
 *
 *   strict    EXISTS a row saying free      -> a food with no row fails
 *   flexible  NOT EXISTS a row saying it    -> a food with no row passes,
 *                                              as `unknown`, and must be
 *                                              flagged by the caller
 *
 * @param {object}   opts
 * @param {string}   opts.foodIdColumn  SQL for the food id, e.g. "f.id"
 * @param {string[]} opts.allergens     slugs or group names
 * @param {string[]} opts.diets         "vegetarian" | "vegan"
 * @param {object}   opts.strictness    per-slug mode, e.g. { lactose: "flexible" }
 * @param {string}   opts.defaultStrictness
 */
export const buildAttributeFilters = ({
  foodIdColumn = "f.id",
  allergens = [],
  diets = [],
  strictness = {},
  defaultStrictness = STRICT,
} = {}) => {
  const foodId = sql.raw(foodIdColumn);
  const { slugs: allergenSlugs, ignored: ignoredAllergens } = normalizeAllergens(allergens);
  const { slugs: dietSlugs, ignored: ignoredDiets } = normalizeDiets(diets);
  const filters = [];
  const flagged = [];

  const rowWhere = (slug, valueExpr) => sql`
    select 1 from food_attributes fa
    join attributes a on a.id = fa.attribute_id
    where fa.food_id = ${foodId} and a.slug = ${slug} and ${valueExpr}`;

  for (const slug of allergenSlugs) {
    if (modeFor(slug, strictness, defaultStrictness) === STRICT) {
      // Must positively be free. No row => fail. This is rule 2.
      filters.push(sql`exists (${rowWhere(slug, sql`fa.value = ${VALUE.IS_NOT}`)})`);
    } else {
      // Must not be known to contain it. No row => pass, as unknown.
      filters.push(sql`not exists (${rowWhere(slug, sql`fa.value = ${VALUE.IS}`)})`);
      flagged.push(slug);
    }
  }

  for (const slug of dietSlugs) {
    if (modeFor(slug, strictness, defaultStrictness) === STRICT) {
      filters.push(sql`exists (${rowWhere(slug, sql`fa.value = ${VALUE.IS}`)})`);
    } else {
      filters.push(sql`not exists (${rowWhere(slug, sql`fa.value = ${VALUE.IS_NOT}`)})`);
      flagged.push(slug);
    }
  }

  return { filters, flagged, ignoredAllergens, ignoredDiets };
};

/**
 * The verdicts for a food, as JSON, so a caller can render the "may contain"
 * flags that flexible mode obliges it to show. Correlated subquery against the
 * same alias the filters use.
 */
export const attributeVerdictsSql = (foodIdColumn = "f.id") => sql`(
  select coalesce(jsonb_object_agg(a.slug, fa.value), '{}'::jsonb)
  from food_attributes fa
  join attributes a on a.id = fa.attribute_id
  where fa.food_id = ${sql.raw(foodIdColumn)} and a.kind in ('allergen', 'diet')
)`;

/**
 * The same rules in plain JS, over a `{ slug: value }` map.
 *
 * Exists so the rules can be tested directly, and so a caller holding verdicts
 * already (from attributeVerdictsSql) can explain a decision without a second
 * query. It MUST agree with buildAttributeFilters; the test suite asserts that
 * against live rows rather than trusting the two to stay in step.
 *
 * A slug absent from `verdicts` is UNKNOWN, never free. Rule 2 again.
 */
export const evaluateFood = (verdicts = {}, {
  allergens = [], diets = [], strictness = {}, defaultStrictness = STRICT,
} = {}) => {
  const { slugs: allergenSlugs } = normalizeAllergens(allergens);
  const { slugs: dietSlugs } = normalizeDiets(diets);
  const blockedBy = [];
  const flaggedBy = [];

  const judge = (slug, passValue) => {
    const v = Object.prototype.hasOwnProperty.call(verdicts, slug)
      ? verdicts[slug] : VALUE.UNKNOWN;
    if (v === passValue) return;
    if (v === VALUE.UNKNOWN && modeFor(slug, strictness, defaultStrictness) === FLEXIBLE) {
      flaggedBy.push(slug);
      return;
    }
    blockedBy.push(slug);
  };

  for (const slug of allergenSlugs) judge(slug, VALUE.IS_NOT);
  for (const slug of dietSlugs) judge(slug, VALUE.IS);

  return { passes: blockedBy.length === 0, blockedBy, flaggedBy };
};

/** Which of the caller's allergens are in flexible mode, so must be flagged. */
export const flaggedAllergensFor = ({
  allergens = [], diets = [], strictness = {}, defaultStrictness = STRICT,
} = {}) => [
  ...normalizeAllergens(allergens).slugs,
  ...normalizeDiets(diets).slugs,
].filter((slug) => modeFor(slug, strictness, defaultStrictness) === FLEXIBLE);
