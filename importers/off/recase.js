/**
 * One-off backfill: apply displayCase.js to the Open Food Facts rows that were
 * loaded before the loader recased names (2026-09-21, device pass found
 * "CHICKEN, LETTUCE & AVOCADO" next to "Egg Fried Rice").
 *
 *   node importers/off/recase.js            # dry run: counts + samples, no writes
 *   node importers/off/recase.js --apply    # write catalog_foods.name / catalog_brands.name
 *
 * Safety: a row is updated only when its CURRENT database name still equals
 * the raw name in off_au.json. A name that was hand-edited since the import
 * is skipped and listed, never overwritten. Only `name` changes; base_name and
 * normalized_name are lower-cased copies and are already equal to the
 * lower-cased new name, which the script asserts before writing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from '@neondatabase/serverless';

import { ENV } from '../../src/config/env.js';
import { recasePayload } from './displayCase.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.resolve(HERE, '../../../tools/off_extract/out/off_au.json');
const CHUNK = 500;

const main = async () => {
  const apply = process.argv.includes('--apply');
  const payload = JSON.parse(readFileSync(JSON_PATH, 'utf-8'));
  const { foods, brands } = recasePayload(payload);

  const foodChanges = foods
    .map((f, i) => ({ publicId: f.public_id, from: payload.foods[i].name, to: f.name }))
    .filter((c) => c.from !== c.to);
  const brandChanges = brands
    .map((b, i) => ({ key: b.normalized_name, from: payload.brands[i].name, to: b.name }))
    .filter((c) => c.from !== c.to);

  for (const c of foodChanges) {
    if (c.to.toLowerCase() !== c.from.toLowerCase()) throw new Error(`letters changed: ${c.from} -> ${c.to}`);
  }

  console.log(`${foodChanges.length.toLocaleString()} food names and ${brandChanges.length} brand names to recase`
    + ` (source ${payload.source_name}, extract ${payload.generated_at})`);
  const sample = (list, n) => list.slice(0, n).forEach((c) => console.log(`  ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`));
  console.log('foods:'); sample(foodChanges, 12);
  console.log('brands:'); sample(brandChanges, 8);
  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write.');
    return;
  }

  const pool = new Pool({ connectionString: ENV.DB_URL });
  const client = await pool.connect();
  const report = { foods: 0, brands: 0, skippedFoods: [], skippedBrands: [] };
  try {
    await client.query('begin');

    for (let i = 0; i < foodChanges.length; i += CHUNK) {
      const slice = foodChanges.slice(i, i + CHUNK);
      // UPDATE ... FROM (VALUES ...) with the raw name in the join, so a row
      // whose name no longer matches the extract is simply not matched.
      const { rows } = await client.query(
        `update catalog_foods f
            set name = v.new_name, updated_at = now()
           from unnest($1::text[], $2::text[], $3::text[]) as v(public_id, old_name, new_name)
          where f.public_id = v.public_id
            and f.source_name = $4
            and f.name = v.old_name
            and lower(v.new_name) = f.normalized_name
        returning f.public_id`,
        [slice.map((c) => c.publicId), slice.map((c) => c.from), slice.map((c) => c.to), payload.source_name],
      );
      const done = new Set(rows.map((r) => r.public_id));
      report.foods += done.size;
      for (const c of slice) if (!done.has(c.publicId)) report.skippedFoods.push(c);
      process.stdout.write(`\r  foods ${Math.min(i + CHUNK, foodChanges.length)}/${foodChanges.length}`);
    }
    console.log();

    const { rows: brandRows } = await client.query(
      `update catalog_brands b
          set name = v.new_name, updated_at = now()
         from unnest($1::text[], $2::text[], $3::text[]) as v(key, old_name, new_name)
        where b.normalized_name = v.key
          and b.name = v.old_name
      returning b.normalized_name`,
      [brandChanges.map((c) => c.key), brandChanges.map((c) => c.from), brandChanges.map((c) => c.to)],
    );
    const doneBrands = new Set(brandRows.map((r) => r.normalized_name));
    report.brands = doneBrands.size;
    for (const c of brandChanges) if (!doneBrands.has(c.key)) report.skippedBrands.push(c);

    await client.query('commit');

    const { rows: [after] } = await client.query(
      `select count(*) filter (where name = upper(name) and name ~ '[A-Za-z]')::int as all_caps,
              count(*) filter (where name = lower(name) and name ~ '[A-Za-z]')::int as all_lower
         from catalog_foods where source_name = $1 and is_active`,
      [payload.source_name],
    );
    report.after = after;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\nUpdated ${report.foods.toLocaleString()} foods and ${report.brands} brands.`);
  const skipped = report.skippedFoods.length + report.skippedBrands.length;
  if (skipped) {
    console.log(`Skipped ${skipped} rows whose current name no longer matches the extract (hand-edited or missing):`);
    [...report.skippedFoods, ...report.skippedBrands].slice(0, 20)
      .forEach((c) => console.log(`  ${c.publicId ?? c.key}: ${JSON.stringify(c.from)}`));
  }

  const { after } = report;
  console.log(`Remaining without case information: ${after.all_caps} all caps, ${after.all_lower} all lower.`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
