/**
 * Post-load verification: does what is IN THE DATABASE match off_au.json?
 *
 * tools/off_extract/verify.py checks the JSON against the parquet; this checks
 * the database against the JSON. Together they cover the whole chain from OFF
 * export to Postgres row. Read-only - it writes nothing.
 *
 *   node importers/off/verify.js
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';

import { ENV } from '../../src/config/env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(
  readFileSync(path.resolve(HERE, '../../../tools/off_extract/out/off_au.json'), 'utf-8'),
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
  const expectedServings = payload.foods.reduce((n, f) => n + f.servings.length, 0);
  const byId = new Map(payload.foods.map((f) => [f.source_record_id, f]));

  console.log(`Verifying the ${SOURCE} import against ${path.basename('off_au.json')}`);
  console.log(`  json: ${expectedFoods.toLocaleString()} products, `
    + `${expectedServings.toLocaleString()} servings, ${payload.brands.length.toLocaleString()} brands`);

  section('A. Counts');
  const c = await one(sql`
    select (select count(*)::int from catalog_foods where source_name = ${SOURCE})          as foods,
           (select count(*)::int from catalog_food_servings s join catalog_foods f
              on f.id = s.food_id where f.source_name = ${SOURCE})                          as servings,
           (select count(*)::int from nutrition_profiles where source_name = ${SOURCE})     as profiles,
           (select count(*)::int from catalog_brands)                                       as brands`);
  report(c.foods === expectedFoods, 'every product in the JSON is in the database',
    `db=${c.foods.toLocaleString()} json=${expectedFoods.toLocaleString()}`);
  report(c.servings === expectedServings, 'every serving is in the database',
    `db=${c.servings.toLocaleString()} json=${expectedServings.toLocaleString()}`);
  report(c.profiles === expectedServings, 'one nutrition profile per serving',
    `profiles=${c.profiles.toLocaleString()}`);
  report(c.brands >= payload.brands.length, 'every brand is in catalog_brands',
    `db=${c.brands.toLocaleString()} json=${payload.brands.length.toLocaleString()}`);

  section('B. AUSNUT is undisturbed');
  const a = await one(sql`
    select (select count(*)::int from catalog_foods where source_name = 'ausnut_2023')      as foods,
           (select count(*)::int from catalog_food_servings s join catalog_foods f
              on f.id = s.food_id where f.source_name = 'ausnut_2023')                      as servings`);
  report(a.foods === 3741, 'AUSNUT foods still 3,741', `${a.foods.toLocaleString()}`);
  report(a.servings === 7330, 'AUSNUT servings still 7,330', `${a.servings.toLocaleString()}`);

  section('C. Referential integrity');
  for (const [label, q] of [
    ['no orphaned nutrition profiles', sql`
      select count(*)::int as n from nutrition_profiles p where p.source_name = ${SOURCE}
        and not exists (select 1 from catalog_food_servings s where s.nutrition_profile_id = p.id)`],
    ['every product has at least one serving', sql`
      select count(*)::int as n from catalog_foods f where f.source_name = ${SOURCE}
        and not exists (select 1 from catalog_food_servings s where s.food_id = f.id)`],
    ['every product has exactly one default serving', sql`
      select count(*)::int as n from catalog_foods f where f.source_name = ${SOURCE}
        and (select count(*) from catalog_food_servings s
             where s.food_id = f.id and s.is_default) <> 1`],
    ['every brand_id resolves', sql`
      select count(*)::int as n from catalog_foods f where f.source_name = ${SOURCE}
        and f.brand_id is not null
        and not exists (select 1 from catalog_brands b where b.id = f.brand_id)`],
  ]) report((await one(q)).n === 0, label, `${(await one(q)).n} bad`);

  section('D. Barcodes');
  const b = await one(sql`
    select count(*)::int                                              as total,
           count(*) filter (where barcode is null)::int               as missing,
           count(distinct barcode)::int                               as distinct_codes,
           count(*) filter (where barcode_type is null)::int          as untyped
    from catalog_foods where source_name = ${SOURCE}`);
  report(b.missing === 0, 'every OFF product carries a barcode', `${b.missing} missing`);
  report(b.distinct_codes === b.total, 'barcodes unique within the source',
    `${b.total - b.distinct_codes} duplicated`);
  report(b.untyped === 0, 'every barcode is typed', `${b.untyped} untyped`);
  const mistyped = await one(sql`
    select count(*)::int as n from catalog_foods where source_name = ${SOURCE}
      and ((barcode_type = 'EAN13' and length(barcode) <> 13)
        or (barcode_type = 'EAN8'  and length(barcode) <> 8)
        or (barcode_type = 'UPC'   and length(barcode) <> 12))`);
  report(mistyped.n === 0, 'barcode_type matches barcode length', `${mistyped.n} wrong`);

  section('E. Nutrition math');
  const sample = payload.foods.slice(0, 300);
  const rows = await all(sql`
    select f.source_record_id as code, s.source_record_id as sid, s.grams_equivalent,
           p.energy_kj, p.calories_kcal, p.sodium_mg, p.protein_g, p.basis_quantity
    from catalog_food_servings s
    join catalog_foods f on f.id = s.food_id
    join nutrition_profiles p on p.id = s.nutrition_profile_id
    where f.source_name = ${SOURCE}
      and f.source_record_id in ${sql.raw(`(${sample.map((f) => `'${f.source_record_id}'`).join(',')})`)}`);
  const seen = new Map(rows.map((r) => [`${r.code} ${r.sid}`, r]));
  let checked = 0; let wrong = 0; const examples = [];
  for (const food of sample) {
    for (const s of food.servings) {
      const row = seen.get(`${food.source_record_id} ${s.source_record_id}`);
      if (!row) continue;
      const scale = Number(row.grams_equivalent) / 100;
      for (const [jsonKey, col] of [['energy_kj', 'energy_kj'], ['sodium_mg', 'sodium_mg'], ['protein_g', 'protein_g']]) {
        const want = food.nutrients[jsonKey];
        if (want === undefined) continue;
        checked += 1;
        if (Math.abs(Number(row[col]) - want * scale) > 0.001) {
          wrong += 1;
          if (examples.length < 3) {
            examples.push(`${food.source_record_id}/${s.sid} ${col}: db=${row[col]} want=${(want * scale).toFixed(4)}`);
          }
        }
      }
    }
  }
  report(wrong === 0, `sampled nutrients match json x grams/100 (${checked.toLocaleString()} values)`,
    wrong ? `${wrong} wrong` : '');
  examples.forEach((e) => console.log(`        ${e}`));

  const labelScaled = await one(sql`
    select count(*)::int as n from catalog_food_servings s
    join catalog_foods f on f.id = s.food_id
    join nutrition_profiles p on p.id = s.nutrition_profile_id
    where f.source_name = ${SOURCE} and s.source_record_id = 'label:serving'
      and abs(p.basis_quantity - s.grams_equivalent) > 0.0001`);
  report(labelScaled.n === 0, 'basis_quantity equals the serving grams on label servings',
    `${labelScaled.n} mismatched`);

  section('F. Provenance kept separate from AUSNUT');
  const meta = await all(sql`
    select source_name, basis_state, carbohydrate_basis,
           coalesce(vitamin_a_convention, 'null') as vit_a, source_derivation, count(*)::int as n
    from nutrition_profiles group by 1,2,3,4,5 order by n desc`);
  for (const m of meta) {
    console.log(`  ${String(m.source_name).padEnd(15)} ${m.basis_state.padEnd(15)} `
      + `carbs=${m.carbohydrate_basis.padEnd(10)} vitA=${String(m.vit_a).padEnd(5)} `
      + `${String(m.source_derivation).padEnd(11)} ${Number(m.n).toLocaleString()}`);
  }
  const offMeta = meta.filter((m) => m.source_name === SOURCE);
  report(offMeta.length === 1 && offMeta[0].basis_state === 'as_sold'
    && offMeta[0].vit_a === 'null' && offMeta[0].source_derivation === 'label_data',
    'OFF profiles are as_sold, vitamin A convention NULL, derivation label_data');
  const ausnutAsSold = await one(sql`
    select count(*)::int as n from nutrition_profiles
    where source_name = 'ausnut_2023' and basis_state <> 'edible_portion'`);
  report(ausnutAsSold.n === 0, 'no AUSNUT profile was flipped to as_sold', `${ausnutAsSold.n} flipped`);

  section('G. The barcode lookup path answers');
  const probe = payload.foods.find((f) => f.brands.length && f.servings.length > 1)
    || payload.foods[0];
  const hit = await one(sql`
    select f.name, f.barcode, b.name as brand, s.description as default_serving,
           round(p.calories_kcal)::int as kcal, round(p.energy_kj)::int as kj
    from catalog_foods f
    left join catalog_brands b on b.id = f.brand_id
    join catalog_food_servings s on s.food_id = f.id and s.is_default
    join nutrition_profiles p on p.id = s.nutrition_profile_id
    where f.barcode = ${probe.barcode} and f.region = 'AU'`);
  report(!!hit, `scanning ${probe.barcode} returns a usable result`);
  if (hit) {
    console.log(`        "${hit.name}" | ${hit.brand ?? 'no brand'} | `
      + `${hit.default_serving} | ${hit.kj} kJ / ${hit.kcal} kcal`);
  }

  const total = await one(sql`
    select count(*)::int as n from catalog_foods where barcode is not null and is_active`);
  console.log(`  scannable products in the catalogue: ${total.n.toLocaleString()}`);

  section('Result');
  if (failures.length) {
    console.log(`  ${failures.length} CHECK(S) FAILED:`);
    failures.forEach((f) => console.log(`    - ${f}`));
    process.exitCode = 1;
  } else {
    console.log('  All checks passed. The database matches off_au.json.');
  }
} finally {
  await pool.end();
}
