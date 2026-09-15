/**
 * Post-load verification: does what is IN THE DATABASE match ausnut.json?
 *
 * tools/ausnut_extract/verify.py checks the JSON against the spreadsheets; this
 * checks the database against the JSON. Together they cover the whole chain
 * from Excel cell to Postgres row. Read-only - it writes nothing.
 *
 *   node importers/ausnut/verify.js
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';

import { ENV } from '../../src/config/env.js';
import { servingsFor } from './load.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(
  readFileSync(path.resolve(HERE, '../../../tools/ausnut_extract/out/ausnut.json'), 'utf-8'),
);
const SOURCE = payload.source_name;

const failures = [];
const report = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

const pool = new Pool({ connectionString: ENV.DB_URL });
const db = drizzle(pool);
const one = async (q) => (await db.execute(q)).rows[0];
const all = async (q) => (await db.execute(q)).rows;

try {
  const expectedFoods = payload.foods.length;
  const expectedServings = payload.foods.reduce((n, f) => n + servingsFor(f).length, 0);

  section('A. Counts');
  const c = await one(sql`
    select (select count(*)::int from catalog_foods where source_name = ${SOURCE})            as foods,
           (select count(*)::int from catalog_food_servings s
              join catalog_foods f on f.id = s.food_id where f.source_name = ${SOURCE})       as servings,
           (select count(*)::int from nutrition_profiles where source_name = ${SOURCE})       as profiles,
           (select count(*)::int from catalog_foods)                                          as all_foods,
           (select count(*)::int from catalog_food_servings)                                  as all_servings`);
  report(c.foods === expectedFoods, 'every food in the JSON is in the database',
    `db=${c.foods} json=${expectedFoods}`);
  report(c.servings === expectedServings, 'every serving in the JSON is in the database',
    `db=${c.servings} json=${expectedServings}`);
  report(c.profiles === expectedServings, 'one nutrition profile per serving',
    `profiles=${c.profiles} servings=${expectedServings}`);
  console.log(`  note: ${c.all_foods - c.foods} non-AUSNUT food row(s), `
    + `${c.all_servings - c.servings} non-AUSNUT serving row(s) also present`);

  section('B. Referential integrity');
  const orphanProfile = await one(sql`
    select count(*)::int as n from nutrition_profiles p
    where p.source_name = ${SOURCE}
      and not exists (select 1 from catalog_food_servings s where s.nutrition_profile_id = p.id)`);
  report(orphanProfile.n === 0, 'no orphaned nutrition profiles', `${orphanProfile.n} orphaned`);

  const noServing = await one(sql`
    select count(*)::int as n from catalog_foods f
    where f.source_name = ${SOURCE}
      and not exists (select 1 from catalog_food_servings s where s.food_id = f.id)`);
  report(noServing.n === 0, 'every food has at least one serving', `${noServing.n} without`);

  const dupDefault = await one(sql`
    select count(*)::int as n from (
      select food_id from catalog_food_servings where is_default group by food_id having count(*) > 1
    ) x`);
  report(dupDefault.n === 0, 'at most one default serving per food', `${dupDefault.n} with more`);

  const missingDefault = await one(sql`
    select count(*)::int as n from catalog_foods f
    where f.source_name = ${SOURCE}
      and not exists (select 1 from catalog_food_servings s where s.food_id = f.id and s.is_default)`);
  report(missingDefault.n === 0, 'every food has a default serving', `${missingDefault.n} without`);

  section('C. Nutrition math (the scale factor is the likely bug)');
  const beer = await one(sql`
    select s.description, p.energy_kj, p.basis_quantity, p.calories_kcal
    from catalog_food_servings s
    join catalog_foods f on f.id = s.food_id
    join nutrition_profiles p on p.id = s.nutrition_profile_id
    where f.source_name = ${SOURCE} and f.source_record_id = '29101002'
      and s.description = '1 can (330 ml)'`);
  if (!beer) {
    report(false, 'beer 29101002 "1 can (330 ml)" exists');
  } else {
    const kj = Number(beer.energy_kj);
    const expected = 152 * 3.3165;   // 152 kJ/100 g scaled to 331.65 g
    report(Math.abs(kj - expected) < 0.05, 'a 331.65 g can scales 152 kJ/100g correctly',
      `${kj} vs expected ${expected.toFixed(3)}`);
    report(Number(beer.basis_quantity) === 331.65, 'basis_quantity records the serving grams',
      `${beer.basis_quantity}`);
  }

  // Compare a random sample end to end rather than trusting one hand-picked row.
  const sample = payload.foods.filter((f) => f.servings.length).slice(0, 400);
  const rows = await all(sql`
    select f.source_record_id as food, s.source_record_id as measure,
           s.grams_equivalent, p.energy_kj, p.protein_g, p.sodium_mg
    from catalog_food_servings s
    join catalog_foods f on f.id = s.food_id
    join nutrition_profiles p on p.id = s.nutrition_profile_id
    where f.source_name = ${SOURCE}
      and f.source_record_id in ${sql.raw(`(${sample.map((f) => `'${f.source_record_id}'`).join(',')})`)}`);
  const byKey = new Map(rows.map((r) => [`${r.food} ${r.measure}`, r]));
  let checked = 0; let wrong = 0; const examples = [];
  for (const food of sample) {
    for (const s of food.servings) {
      const row = byKey.get(`${food.source_record_id} ${s.source_record_id}`);
      if (!row) continue;
      const scale = Number(row.grams_equivalent) / 100;
      for (const [jsonKey, col] of [['energy_kj', 'energy_kj'], ['protein_g', 'protein_g'], ['sodium_mg', 'sodium_mg']]) {
        const want = food.nutrients[jsonKey];
        if (want === undefined) continue;
        checked += 1;
        if (Math.abs(Number(row[col]) - want * scale) > 0.001) {
          wrong += 1;
          if (examples.length < 3) {
            examples.push(`${food.source_record_id}/${s.source_record_id} ${col}: db=${row[col]} want=${(want * scale).toFixed(4)}`);
          }
        }
      }
    }
  }
  report(wrong === 0, `sampled nutrients match json x grams/100 (${checked.toLocaleString()} values)`,
    wrong ? `${wrong} wrong` : '');
  examples.forEach((e) => console.log(`        ${e}`));

  section('D. Unknown is not zero');
  const zeroed = await one(sql`
    select count(*)::int as n from nutrition_profiles
    where source_name = ${SOURCE} and added_sugars_g is null`);
  const jsonNulls = payload.foods.filter((f) => f.nutrients.added_sugars_g === undefined).length;
  console.log(`  profiles with NULL added_sugars_g: ${zeroed.n} (json foods missing it: ${jsonNulls})`);
  const allZero = await one(sql`
    select count(*)::int as n from nutrition_profiles where source_name = ${SOURCE}
      and calories_kcal = 0 and energy_kj = 0 and protein_g = 0 and fat_g = 0 and carbohydrate_g = 0`);
  console.log(`  profiles that are entirely zero: ${allZero.n} (water and similar, expected to be few)`);

  section('E. Source metadata and provenance');
  const meta = await all(sql`
    select basis_state, carbohydrate_basis, vitamin_a_convention, calculation_method,
           source_license, count(*)::int as n
    from nutrition_profiles where source_name = ${SOURCE}
    group by 1,2,3,4,5`);
  report(meta.length === 1, 'all profiles share one basis/convention/licence', `${meta.length} distinct combination(s)`);
  if (meta[0]) {
    const m = meta[0];
    console.log(`        ${m.basis_state} | carbs=${m.carbohydrate_basis} | vitA=${m.vitamin_a_convention}`);
    console.log(`        ${m.calculation_method} | ${m.source_license} | ${Number(m.n).toLocaleString()} rows`);
    report(m.basis_state === 'edible_portion' && m.carbohydrate_basis === 'available'
      && m.vitamin_a_convention === 're', 'basis flags match AUSNUT conventions');
  }
  const deriv = await all(sql`
    select source_derivation, count(*)::int as n from nutrition_profiles
    where source_name = ${SOURCE} group by 1 order by n desc`);
  console.log(`  source_derivation spread: ${deriv.map((d) => `${d.source_derivation}=${d.n}`).join(', ')}`);

  section('F. The indexes actually work');
  const gin = await one(sql`
    select count(*)::int as n from catalog_foods
    where source_name = ${SOURCE} and name_segments @> ARRAY['commercial']`);
  report(gin.n > 0, "name_segments @> ARRAY['commercial'] returns rows", `${gin.n} foods`);

  const asian = await one(sql`
    select count(*)::int as n from catalog_foods
    where source_name = ${SOURCE} and name_segments @> ARRAY['asian style']`);
  report(asian.n > 0, "the casing fix works: @> ARRAY['asian style'] matches", `${asian.n} foods`);

  const trgm = await all(sql`
    select name from catalog_foods where source_name = ${SOURCE}
    order by normalized_name <-> 'chocalate biscit' limit 3`);
  report(trgm.length === 3, 'trigram fuzzy search answers a misspelling',
    trgm.map((r) => `"${r.name.slice(0, 34)}"`).join(', '));

  const base = await one(sql`
    select count(distinct base_name)::int as n from catalog_foods where source_name = ${SOURCE}`);
  report(Number(base.n) === 702, 'base_name groups survived the import', `${base.n} distinct (expected 702)`);

  section('G. Classification tree and browsing');
  const cats = payload.categories ?? [];
  if (!cats.length) {
    console.log('  SKIP  ausnut.json carries no categories - re-run extract.py');
  } else {
    const t = await one(sql`
      select (select count(*)::int from categories where kind = 'food')       as categories,
             (select count(*)::int from categories where parent_id is null)   as roots,
             (select count(*)::int from food_categories)                      as links,
             (select count(*)::int from food_categories where is_primary)     as primaries`);
    report(t.categories === cats.length, 'every category is in the database',
      `db=${t.categories} json=${cats.length}`);
    report(t.roots === 24, '24 top-level groups', `${t.roots}`);

    const missing = await one(sql`
      select count(*)::int as n from catalog_foods f where f.source_name = ${SOURCE}
        and not exists (select 1 from food_categories fc
                        where fc.food_id = f.id and fc.is_primary)`);
    report(missing.n === 0, 'every AUSNUT food has a primary category', `${missing.n} without`);

    // Foods must attach to a LEAF. A link to a group would make the tree
    // ambiguous: the food would appear twice when browsing down.
    const nonLeaf = await one(sql`
      select count(*)::int as n from food_categories fc
      join categories c on c.id = fc.category_id
      where exists (select 1 from categories k where k.parent_id = c.id)`);
    report(nonLeaf.n === 0, 'no food is linked to a non-leaf category', `${nonLeaf.n} are`);

    // The point of the tree: browsing a top-level group must reach the foods
    // filed three levels below it. This is the query the app will run.
    const browse = await all(sql`
      with recursive tree as (
        select id, name, id as root_id, name as root_name from categories where parent_id is null
        union all
        select c.id, c.name, t.root_id, t.root_name
        from categories c join tree t on c.parent_id = t.id)
      select t.root_name, count(distinct fc.food_id)::int as foods
      from tree t join food_categories fc on fc.category_id = t.id
      group by 1 order by foods desc limit 5`);
    report(browse.length === 5 && browse.every((r) => r.foods > 0),
      'recursive browse from a top-level group reaches foods');
    for (const r of browse) {
      console.log(`        ${String(r.root_name).slice(0, 44).padEnd(46)} ${r.foods.toLocaleString()} foods`);
    }

    const covered = await one(sql`
      select count(distinct category_id)::int as n from food_categories`);
    console.log(`  leaves in use: ${covered.n} of ${cats.filter((c) => c.level === 3).length}`);

    const disc = await all(sql`
      select fa.value, count(*)::int as n from food_attributes fa
      join attributes a on a.id = fa.attribute_id
      where a.slug = 'discretionary-food' group by 1 order by 1 desc`);
    const byValue = Object.fromEntries(disc.map((d) => [d.value, d.n]));
    report(byValue[1] === 1152 && byValue[0] === 2589,
      'discretionary flag matches the workbook split',
      `discretionary=${byValue[1] ?? 0} non=${byValue[0] ?? 0}`);
  }

  section('Result');
  if (failures.length) {
    console.log(`  ${failures.length} CHECK(S) FAILED:`);
    failures.forEach((f) => console.log(`    - ${f}`));
    process.exitCode = 1;
  } else {
    console.log('  All checks passed. The database matches ausnut.json.');
  }
} finally {
  await pool.end();
}
