/**
 * Phase 3 — catalogue-wide data quality audit (checklist p3-03, p3-08).
 *
 * This is deliberately NOT a third source verifier. importers/ausnut/verify.js
 * and importers/off/verify.js each compare the database against their OWN
 * extract JSON, so between them they prove "the loader moved the numbers
 * faithfully". Neither can catch a number that was already wrong in the source,
 * and neither has ever looked at the two sources side by side.
 *
 * So this file reads only the database and asks two different questions:
 *   1. Are the numbers physically possible?  (energy vs macros, mass budget)
 *   2. Do the two sources agree, and are their conventions kept distinct?
 *
 * Because it touches no JSON it cannot drift when an extractor is re-run.
 * Read-only: it writes nothing and opens no transaction.
 *
 *   node importers/catalog_audit.js
 *   node importers/catalog_audit.js --verbose   (list every flagged food)
 */
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';

import { ENV } from '../src/config/env.js';
import {
  PLAUSIBILITY_RULES, per100, defaultServingJoin, MASS_NOTE_G, MASS_FAIL_G,
} from './catalog_rules.js';

const VERBOSE = process.argv.includes('--verbose');

// FSANZ Standard 1.2.8 energy factors, kJ per gram. These are the AU legal
// factors and the ones AUSNUT itself uses, which is why reconstructing energy
// with them is what settled the carbohydrate-basis question back in August.
const KJ_PER_G = { protein: 17, fat: 37, carbohydrate: 16, fibre: 8, alcohol: 29 };

// A food is flagged only if it misses by BOTH a relative and an absolute
// margin. The absolute floor exists because diet drinks, black coffee and
// water sit near 0 kJ, where any rounding difference is a huge percentage.
const TOLERANCE_PCT = 0.20;
const TOLERANCE_KJ = 40;

const failures = [];
const warnings = [];
const report = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const note = (label, detail = '') => {
  console.log(`  NOTE  ${label}${detail ? `  ${detail}` : ''}`);
  warnings.push(label);
};
const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);
const n = (x) => Number(x).toLocaleString();

const pool = new Pool({ connectionString: ENV.DB_URL });
const db = drizzle(pool);
const one = async (q) => (await db.execute(q)).rows[0];
const all = async (q) => (await db.execute(q)).rows;

try {
  console.log('Catalogue-wide data quality audit (Phase 3)');
  console.log('Read-only. Compares the database against physics and against itself.');

  // ---------------------------------------------------------------------------
  section('A. What is being audited');

  const sources = await all(sql`
    select f.source_name,
           count(*)::int                              as foods,
           min(p.basis_state)                         as basis_state,
           min(p.carbohydrate_basis)                  as carb_basis,
           count(distinct p.carbohydrate_basis)::int  as carb_bases
    from catalog_foods f
    join catalog_food_servings s on s.food_id = f.id and s.is_default
    join nutrition_profiles p on p.id = s.nutrition_profile_id
    group by 1 order by 2 desc`);

  for (const s of sources) {
    console.log(`  ${String(s.source_name).padEnd(15)} ${n(s.foods).padStart(7)} foods  `
      + `basis=${s.basis_state} carbs=${s.carb_basis}`);
  }

  // Every food must have a default serving, or it is invisible to every join in
  // this file AND to the API that Phase 4 will build on top of the same shape.
  const stranded = await all(sql`
    select f.id, f.source_name, f.name, f.public_id, f.barcode, f.region, f.created_at
    from catalog_foods f
    where not exists (select 1 from catalog_food_servings s
                      where s.food_id = f.id and s.is_default)
    order by f.id`);
  report(stranded.length === 0, 'every food has a default serving',
    stranded.length ? `${n(stranded.length)} stranded` : '');
  for (const r of stranded) {
    console.log(`        id=${r.id} "${r.name}" ${r.public_id} `
      + `barcode=${r.barcode ?? 'none'} region=${r.region} created=${String(r.created_at).slice(0, 16)}`);
  }

  // The energy reconstruction below adds fibre separately at 8 kJ/g. That is
  // only correct when carbohydrate EXCLUDES fibre. If a future source lands as
  // 'by_difference' the maths silently double-counts fibre, so assert it here
  // rather than producing quietly wrong numbers.
  const mixedBasis = sources.filter((s) => s.carb_basis !== 'available' || s.carb_bases !== 1);
  report(mixedBasis.length === 0,
    "every source is carbohydrate_basis='available' (fibre counted separately)",
    mixedBasis.length ? `${mixedBasis.map((s) => s.source_name).join(', ')} differ` : '');

  // ---------------------------------------------------------------------------
  section('B. Energy reconciliation — p3-03');
  console.log('  Rebuilds energy from macros with FSANZ factors (17/37/16/8 kJ/g) and');
  console.log('  compares against the stored energy_kj. Catches mg-in-a-g-column and');
  console.log('  per-serving-vs-per-100g mix-ups that a source-vs-source check cannot.\n');

  // One row per food: the default serving. Every other serving of a food is a
  // linear scaling of the same per-100 g figures, so the predicted/actual RATIO
  // is identical across them and checking one is sufficient.
  //
  // Only foods with protein, fat, carbohydrate AND energy all present are
  // evaluable. coalesce(...,0) on a missing macro would treat unknown as zero,
  // which is precisely the error this schema was built to avoid.
  const energyBase = sql`
    select f.id, f.name, f.source_name,
           ${per100('p.energy_kj')}            as kj,
           ${per100('p.protein_g')}            as protein,
           ${per100('p.fat_g')}                as fat,
           ${per100('p.carbohydrate_g')}       as carb,
           ${per100('coalesce(p.fiber_g,0)')}  as fibre
    from catalog_foods f
    join catalog_food_servings s on s.food_id = f.id and s.is_default
    join nutrition_profiles p on p.id = s.nutrition_profile_id
    where p.energy_kj is not null and p.protein_g is not null
      and p.fat_g is not null and p.carbohydrate_g is not null
      and p.basis_quantity > 0`;

  const coverage = await one(sql`
    select (select count(*)::int from catalog_foods)     as all_foods,
           (select count(*)::int from (${energyBase}) b) as evaluable`);
  console.log(`  evaluable: ${n(coverage.evaluable)} of ${n(coverage.all_foods)} foods `
    + `(${((coverage.evaluable / coverage.all_foods) * 100).toFixed(1)}% have energy + all three macros)`);

  const energyRows = await all(sql`
    with b as (${energyBase}),
    scored as (
      select *, protein * ${KJ_PER_G.protein} + fat * ${KJ_PER_G.fat}
                + carb * ${KJ_PER_G.carbohydrate} + fibre * ${KJ_PER_G.fibre} as predicted
      from b)
    select *, predicted - kj                        as gap,
              (kj - predicted) / ${KJ_PER_G.alcohol} as implied_alcohol_g
    from scored
    where abs(predicted - kj) > ${TOLERANCE_KJ}
      and abs(predicted - kj) > kj * ${TOLERANCE_PCT}
    order by abs(predicted - kj) desc`);

  const bySource = new Map();
  for (const r of energyRows) bySource.set(r.source_name, (bySource.get(r.source_name) ?? 0) + 1);

  console.log(`  flagged:   ${n(energyRows.length)} `
    + `(${((energyRows.length / coverage.evaluable) * 100).toFixed(2)}%) `
    + `miss by >${TOLERANCE_PCT * 100}% AND >${TOLERANCE_KJ} kJ`);
  for (const s of sources) {
    console.log(`             ${String(s.source_name).padEnd(15)} ${n(bySource.get(s.source_name) ?? 0).padStart(6)}`);
  }

  // The schema has no alcohol_g column, so an alcoholic food's energy can never
  // be reconstructed: 29 kJ/g of ethanol is simply invisible to the maths. Those
  // rows UNDER-predict by an amount implying a plausible ABV. Separating them
  // stops a known modelling gap from being reported as a data defect.
  const alcoholic = new Set();
  for (const r of energyRows) {
    const g = Number(r.implied_alcohol_g);
    if (Number(r.gap) < 0 && g > 0.5 && g < 60) alcoholic.add(r.id);
  }
  const unexplained = energyRows.filter((r) => !alcoholic.has(r.id));

  console.log(`\n  ${n(alcoholic.size)} under-predict by an amount consistent with unmodelled`);
  console.log(`  alcohol (there is no alcohol_g column), leaving ${n(unexplained.length)} unexplained.`);

  const show = VERBOSE ? unexplained : unexplained.slice(0, 15);
  if (show.length) {
    console.log('\n  Worst unexplained (per 100 g):');
    console.log('    stored kJ  predicted  gap      source         name');
    for (const r of show) {
      console.log(`    ${String(Math.round(r.kj)).padStart(9)}  ${String(Math.round(r.predicted)).padStart(9)}  `
        + `${String(Math.round(r.gap)).padStart(7)}  ${String(r.source_name).padEnd(13)}  ${String(r.name).slice(0, 58)}`);
    }
    if (!VERBOSE && unexplained.length > show.length) {
      console.log(`    ... ${n(unexplained.length - show.length)} more, run with --verbose`);
    }
  }

  // A handful of stragglers among 46,002 crowdsourced label rows is a cleanup
  // task, not a broken importer. A large fraction means something systematic,
  // which is what this check exists to surface.
  const unexplainedPct = (unexplained.length / coverage.evaluable) * 100;
  report(unexplainedPct < 1.0, 'under 1% of evaluable foods have unexplained energy',
    `${unexplainedPct.toFixed(2)}%`);

  // ---------------------------------------------------------------------------
  section('C. Composition plausibility — catalogue-wide');
  console.log('  tools/ausnut_extract/verify.py runs versions of these against the');
  console.log("  spreadsheets, but OFF's 46,002 rows have never been checked this way.");
  console.log('  Rules come from catalog_rules.js, shared with catalog_quarantine.js.');
  console.log('  Counted as DISTINCT FOODS on the default serving, not servings.');
  console.log('  Only ACTIVE foods can fail; anything already retired is reported separately.\n');

  const retired = await one(sql`
    select count(*)::int as n from catalog_foods where not is_active`);
  if (retired.n > 0) console.log(`  ${n(retired.n)} foods are already retired (is_active = false).\n`);

  // Mass budget, banded. Reported separately from the pass/fail because
  // 100-105 g is measurement noise on dry foods and 105+ is a real error.
  const massBands = await all(sql`
    with s100 as (
      select f.source_name, f.is_active,
             ${per100('p.protein_g')} + ${per100('p.fat_g')}
               + ${per100('p.carbohydrate_g')} + ${per100('coalesce(p.fiber_g,0)')} as total
      from catalog_foods f
      join catalog_food_servings s on s.food_id = f.id and s.is_default
      join nutrition_profiles p on p.id = s.nutrition_profile_id
      where p.protein_g is not null and p.fat_g is not null
        and p.carbohydrate_g is not null and p.basis_quantity > 0)
    select source_name,
           count(*) filter (where total > ${MASS_NOTE_G} and total <= ${MASS_FAIL_G})::int as noise,
           count(*) filter (where total > ${MASS_FAIL_G} and is_active)::int                as bad,
           count(*) filter (where total > ${MASS_FAIL_G} and not is_active)::int            as bad_retired,
           round(max(total)::numeric, 1)                                                    as worst
    from s100 group by 1 order by 1`);

  for (const b of massBands) {
    console.log(`  ${String(b.source_name).padEnd(15)} ${n(b.noise).padStart(5)} in `
      + `${MASS_NOTE_G}-${MASS_FAIL_G} g (noise)   ${n(b.bad).padStart(5)} over ${MASS_FAIL_G} g active`
      + `${b.bad_retired ? `, ${n(b.bad_retired)} retired` : ''}   worst ${b.worst} g`);
  }

  for (const rule of PLAUSIBILITY_RULES) {
    const base = sql`${defaultServingJoin(true)} and (${rule.predicate})`;
    const r = await one(sql`
      select count(*)::int as n,
             count(*) filter (where f.source_name = 'ausnut_2023')::int   as ausnut,
             count(*) filter (where f.source_name = 'openfoodfacts')::int as off ${base}`);

    const label = rule.quarantine ? rule.label : `${rule.label} [advisory]`;
    const detail = r.n === 0 ? '' : `${n(r.n)} foods (ausnut ${n(r.ausnut)}, off ${n(r.off)})`;
    // Advisory rules never fail the run — they flag rows for a human, and
    // automating them would retire legitimate products. See catalog_rules.js.
    if (rule.quarantine) report(r.n === 0, label, detail);
    else if (r.n > 0) note(label, detail);
    else report(true, label);

    if (r.n > 0) {
      const worst = await all(sql`
        select f.name, f.source_name,
               round(${per100('p.protein_g')}::numeric, 1)      as protein,
               round(${per100('p.fat_g')}::numeric, 1)          as fat,
               round(${per100('p.carbohydrate_g')}::numeric, 1) as carb,
               round(${per100('p.sugar_g')}::numeric, 1)        as sugar,
               round(${per100('p.sodium_mg')}::numeric, 0)      as sodium ${base}
        limit ${VERBOSE ? 40 : 5}`);
      for (const w of worst) {
        console.log(`          ${String(w.source_name).padEnd(13)} pro=${w.protein} fat=${w.fat} `
          + `carb=${w.carb} sug=${w.sugar} na=${w.sodium}  ${String(w.name).slice(0, 44)}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  section('D. Convention separation — p3-08');

  const conv = await all(sql`
    select source_name, basis_state, carbohydrate_basis,
           coalesce(vitamin_a_convention, 'NULL') as vit_a,
           coalesce(source_derivation, 'NULL')    as derivation,
           count(*)::int as rows
    from nutrition_profiles group by 1,2,3,4,5 order by 1, rows desc`);
  for (const c of conv) {
    console.log(`  ${String(c.source_name).padEnd(15)} ${String(c.basis_state).padEnd(15)} `
      + `carbs=${String(c.carbohydrate_basis).padEnd(10)} vitA=${String(c.vit_a).padEnd(5)} `
      + `${String(c.derivation).padEnd(11)} ${n(c.rows).padStart(7)}`);
  }

  const bleed = await one(sql`
    select count(*) filter (where source_name = 'ausnut_2023'
             and (basis_state <> 'edible_portion'
                  or vitamin_a_convention is distinct from 're'))::int as ausnut,
           count(*) filter (where source_name = 'openfoodfacts'
             and (basis_state <> 'as_sold' or vitamin_a_convention is not null))::int as off
    from nutrition_profiles`);
  report(bleed.ausnut === 0, "AUSNUT profiles are all edible_portion + vitamin A 're'", `${n(bleed.ausnut)} bad`);
  report(bleed.off === 0, 'OFF profiles are all as_sold + vitamin A convention NULL', `${n(bleed.off)} bad`);

  // The real blending hazard: a vitamin A value with no stated convention cannot
  // be averaged against or compared with AUSNUT's RE values, because RE and RAE
  // differ by a factor of two on beta-carotene. If OFF never populates the value
  // the hazard is theoretical; if it does, an explicit rule is needed before any
  // API blends the two sources.
  const vitA = await one(sql`
    select count(*)::int as profiles, count(distinct s.food_id)::int as foods
    from nutrition_profiles p
    join catalog_food_servings s on s.nutrition_profile_id = p.id
    where p.vitamin_a_mcg is not null and p.vitamin_a_convention is null`);
  if (vitA.profiles === 0) {
    report(true, 'no vitamin A value carries an unknown convention', 'hazard is theoretical');
  } else {
    // RULE DECIDED 2026-09-03: never blend across conventions. Phase 4 must
    // return vitamin A with its convention attached and must never average or
    // compare two values whose conventions differ or are unknown. The values
    // are kept (they are real label figures); the constraint lives in the API.
    note(`${n(vitA.foods)} foods carry a vitamin A value with NO convention`,
      'RULE: never blend across conventions — Phase 4 returns vitamin A with its convention attached');
  }

  // ---------------------------------------------------------------------------
  section('E. Same food, both sources — p3-08 / p3-04');
  console.log('  Matched with pg_trgm, which is what Phase 4 search will use. AUSNUT is');
  console.log('  edible_portion, OFF is as_sold, so these SHOULD differ for anything with');
  console.log('  peel, bone or shell and agree closely for a processed food.\n');

  const probes = ['olive oil', 'cheddar cheese', 'rolled oats', 'baked beans', 'peanut butter',
    'banana', 'white bread', 'greek yoghurt', 'tomato sauce', 'full cream milk'];

  for (const term of probes) {
    console.log(`  "${term}"`);
    for (const [tag, src] of [['AUSNUT', 'ausnut_2023'], ['OFF   ', 'openfoodfacts']]) {
      const r = await one(sql`
        select f.name, f.base_name,
               round(similarity(f.normalized_name, ${term})::numeric, 2)  as sim,
               round(${per100('p.energy_kj')}::numeric, 0)      as kj,
               round(${per100('p.protein_g')}::numeric, 1)      as protein,
               round(${per100('p.fat_g')}::numeric, 1)          as fat,
               round(${per100('p.carbohydrate_g')}::numeric, 1) as carb
        from catalog_foods f
        join catalog_food_servings s on s.food_id = f.id and s.is_default
        join nutrition_profiles p on p.id = s.nutrition_profile_id
        where f.source_name = ${src} and f.is_active
          and p.energy_kj is not null and p.basis_quantity > 0
        order by similarity(f.normalized_name, ${term}) desc, length(f.name)
        limit 1`);
      if (!r) { console.log(`    ${tag}  no match`); continue; }
      console.log(`    ${tag}  ${String(r.kj).padStart(5)} kJ  pro ${String(r.protein).padStart(5)}  `
        + `fat ${String(r.fat).padStart(5)}  carb ${String(r.carb).padStart(5)}  `
        + `sim ${r.sim}  ${String(r.name).slice(0, 42)}`);
    }
  }

  // ---------------------------------------------------------------------------
  section('Result');
  if (failures.length) {
    console.log(`  ${failures.length} CHECK(S) FAILED:`);
    failures.forEach((f) => console.log(`    - ${f}`));
    process.exitCode = 1;
  } else {
    console.log('  All automated checks passed.');
  }
  if (warnings.length) {
    console.log(`\n  ${warnings.length} note(s) needing a decision:`);
    warnings.forEach((w) => console.log(`    - ${w}`));
  }
  console.log('\n  Section E is for human judgement — it always prints, never fails.');
} finally {
  await pool.end();
}
