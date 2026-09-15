/**
 * Retires catalogue foods whose nutrition is physically impossible (checklist
 * p3-03 follow-up). Sets is_active = false; it never deletes.
 *
 * Why retire rather than delete: the 2026-08-25 constraint finding. Deleting a
 * catalog_foods row fires two referential actions on the same recipe_ingredients
 * row — the composite FK SET NULL nulls both columns, the plain food_id FK nulls
 * one — and if the second fires first, the transient (serving set, food NULL)
 * state trips the CHECK. Trigger order is uncontrollable and CHECKs cannot be
 * DEFERRABLE. is_active = false sidesteps all of it, stays auditable, and is
 * reversible with a single UPDATE.
 *
 * The rules come from catalog_rules.js, shared with catalog_audit.js, so the
 * thing that reports and the thing that acts can never disagree.
 *
 *   node importers/catalog_quarantine.js --dry-run    (default: shows, writes nothing)
 *   node importers/catalog_quarantine.js --apply
 *   node importers/catalog_quarantine.js --restore    (reactivate everything retired here)
 */
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';

import { ENV } from '../src/config/env.js';
import { QUARANTINE_RULES, anyViolation, defaultServingJoin, per100 } from './catalog_rules.js';

const APPLY = process.argv.includes('--apply');
const RESTORE = process.argv.includes('--restore');
const n = (x) => Number(x).toLocaleString();

const pool = new Pool({ connectionString: ENV.DB_URL });
const db = drizzle(pool);
const one = async (q) => (await db.execute(q)).rows[0];
const all = async (q) => (await db.execute(q)).rows;

try {
  if (RESTORE) {
    const r = await one(sql`
      with restored as (
        update catalog_foods set is_active = true, updated_at = now()
        where is_active = false returning id)
      select count(*)::int as n from restored`);
    console.log(`Reactivated ${n(r.n)} foods. Re-run catalog_audit.js to see them flagged again.`);
    process.exit(0);
  }

  console.log(`Catalogue quarantine — ${APPLY ? 'APPLY' : 'DRY RUN (nothing is written)'}`);
  console.log('Retires foods failing a deterministic plausibility rule. Sets is_active = false.\n');

  // Per-rule counts first, so the report says WHY each food is going, not just
  // how many. A food can break more than one rule, so these sum to more than
  // the total.
  console.log('  Violations among currently-active foods:');
  for (const rule of QUARANTINE_RULES) {
    const r = await one(sql`
      select count(*)::int as n,
             count(*) filter (where f.source_name = 'ausnut_2023')::int   as ausnut,
             count(*) filter (where f.source_name = 'openfoodfacts')::int as off
      ${defaultServingJoin(true)} and (${rule.predicate})`);
    console.log(`    ${String(rule.key).padEnd(16)} ${n(r.n).padStart(6)} foods `
      + `(ausnut ${n(r.ausnut)}, off ${n(r.off)})   ${rule.label}`);
  }

  const violates = anyViolation(QUARANTINE_RULES);

  const totals = await one(sql`
    select count(*)::int as n,
           count(*) filter (where f.source_name = 'ausnut_2023')::int   as ausnut,
           count(*) filter (where f.source_name = 'openfoodfacts')::int as off
    ${defaultServingJoin(true)} and (${violates})`);

  const catalogue = await one(sql`
    select count(*)::int as total, count(*) filter (where is_active)::int as active
    from catalog_foods`);

  console.log(`\n  Distinct foods to retire: ${n(totals.n)} `
    + `(ausnut ${n(totals.ausnut)}, off ${n(totals.off)})`);
  console.log(`  That is ${((totals.n / catalogue.active) * 100).toFixed(2)}% of `
    + `${n(catalogue.active)} active foods.`);

  // Anything AUSNUT is a red flag, not routine cleanup: AUSNUT is lab-measured
  // government data and passed every one of these checks on 2026-09-03. If it
  // starts failing, the cause is far more likely a bug in the rules or the
  // importer than bad data from FSANZ.
  if (totals.ausnut > 0) {
    console.log('\n  WARNING: AUSNUT rows are implicated. AUSNUT passed all of these');
    console.log('  checks on 2026-09-03, so investigate before applying — this is more');
    console.log('  likely a rule bug than a data defect.');
  }

  const sample = await all(sql`
    select f.id, f.name, f.source_name, f.barcode,
           round((${per100('p.protein_g')} + ${per100('p.fat_g')}
             + ${per100('p.carbohydrate_g')} + ${per100('coalesce(p.fiber_g,0)')})::numeric, 1) as mass,
           round(${per100('p.fat_g')}::numeric, 1)          as fat,
           round(${per100('p.carbohydrate_g')}::numeric, 1) as carb,
           round(${per100('p.sugar_g')}::numeric, 1)        as sugar
    ${defaultServingJoin(true)} and (${violates})
    order by (${per100('p.protein_g')} + ${per100('p.fat_g')}
      + ${per100('p.carbohydrate_g')} + ${per100('coalesce(p.fiber_g,0)')}) desc
    limit 15`);
  console.log('\n  Worst offenders by mass budget:');
  console.log('    mass_g   fat   carb  sugar  name');
  for (const r of sample) {
    console.log(`    ${String(r.mass).padStart(6)}  ${String(r.fat).padStart(5)} `
      + `${String(r.carb).padStart(5)}  ${String(r.sugar).padStart(5)}  ${String(r.name).slice(0, 52)}`);
  }

  if (!APPLY) {
    console.log('\n  DRY RUN — nothing written. Re-run with --apply to retire these.');
    process.exit(0);
  }

  // One statement, so it is atomic without needing an explicit transaction.
  // The id subquery is required because UPDATE cannot carry the join above.
  const applied = await one(sql`
    with bad as (select f.id ${defaultServingJoin(true)} and (${violates})),
    updated as (
      update catalog_foods set is_active = false, updated_at = now()
      where id in (select id from bad) returning id)
    select count(*)::int as n from updated`);

  const after = await one(sql`
    select count(*) filter (where is_active)::int as active,
           count(*) filter (where not is_active)::int as retired
    from catalog_foods`);

  console.log(`\n  Retired ${n(applied.n)} foods.`);
  console.log(`  Catalogue now: ${n(after.active)} active, ${n(after.retired)} retired.`);
  console.log('\n  Next: re-run importers/catalog_audit.js — the plausibility checks');
  console.log('  should pass, since they only consider active foods.');
} finally {
  await pool.end();
}
