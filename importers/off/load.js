/**
 * Stage 2 of the Open Food Facts import: read tools/off_extract/out/off_au.json
 * and write catalog_brands + catalog_foods + nutrition_profiles +
 * catalog_food_servings.
 *
 * Stage 1 (tools/off_extract/extract.py) owns every OFF quirk: the 100g-is-
 * grams trap, the corrupt per-row unit field, the physiological ceilings and
 * the energy reconciliation. This file owns the database and nothing else.
 * Verify the JSON with tools/off_extract/verify.py BEFORE running this.
 *
 *   node importers/off/load.js --dry-run        # rolls back, prints the report
 *   node importers/off/load.js --limit 200      # first 200 products only
 *   node importers/off/load.js                  # real import
 *
 * Idempotent: brands upsert on normalized_name, foods on
 * (source_name, source_record_id), servings on (food_id, source_record_id).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { inArray, sql } from 'drizzle-orm';

import { ENV } from '../../src/config/env.js';
import {
  catalogBrandsTable,
  catalogFoodsTable,
  catalogFoodServingsTable,
  nutritionProfilesTable,
} from '../../src/db/food_schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.resolve(HERE, '../../../tools/off_extract/out/off_au.json');

const REGION = 'AU';
const LANGUAGE = 'en-AU';
const FOOD_TYPE = 'branded';
const VERIFICATION = 'unverified';

// OFF publishes manufacturer label declarations, so 'label_data' is the honest
// derivation tier. AUSNUT rows carry 'analysed'/'recipe'/etc., and recording
// this makes the eventual AUSNUT-vs-OFF blending tiebreak meaningful instead of
// comparing a known tier against NULL.
const SOURCE_DERIVATION = 'label_data';

const CHUNK = 200;

// JSON already uses our column names; this maps snake_case to the Drizzle keys.
const NUTRIENT_COLUMNS = {
  calories_kcal: 'caloriesKcal',
  energy_kj: 'energyKj',
  protein_g: 'proteinG',
  carbohydrate_g: 'carbohydrateG',
  fat_g: 'fatG',
  saturated_fat_g: 'saturatedFatG',
  trans_fat_g: 'transFatG',
  polyunsaturated_fat_g: 'polyunsaturatedFatG',
  monounsaturated_fat_g: 'monounsaturatedFatG',
  cholesterol_mg: 'cholesterolMg',
  sodium_mg: 'sodiumMg',
  potassium_mg: 'potassiumMg',
  fiber_g: 'fiberG',
  sugar_g: 'sugarG',
  added_sugars_g: 'addedSugarsG',
  vitamin_d_mcg: 'vitaminDMcg',
  calcium_mg: 'calciumMg',
  iron_mg: 'ironMg',
  vitamin_a_mcg: 'vitaminAMcg',
  vitamin_c_mg: 'vitaminCMg',
};

const round4 = (n) => Math.round(n * 1e4) / 1e4;
const key = (foodId, sourceRecordId) => `${foodId} ${sourceRecordId}`;

class Rollback extends Error {}

/**
 * OFF nutrition is per 100 g, so each serving's profile is those values scaled
 * by grams/100, exactly as the AUSNUT importer does.
 */
export function profileFor(food, serving, meta) {
  const scale = serving.grams_equivalent / 100;
  const row = {
    basisQuantity: round4(serving.grams_equivalent),
    basisUnit: 'g',
    // as_sold, NOT AUSNUT's edible_portion. The difference is real for
    // anything with peel, bone or shell.
    basisState: meta.basis_state,
    carbohydrateBasis: meta.carbohydrate_basis,
    // NULL for OFF: it states neither RE nor RAE, and guessing 'rae' would
    // corrupt blending against AUSNUT's 're'.
    vitaminAConvention: meta.vitamin_a_convention ?? null,
    calculationMethod: 'scaled_from_per_100g',
    sourceName: meta.source_name,
    sourceLicense: meta.source_license,
    sourceDerivation: SOURCE_DERIVATION,
  };
  for (const [jsonKey, column] of Object.entries(NUTRIENT_COLUMNS)) {
    const value = food.nutrients[jsonKey];
    row[column] = value === undefined || value === null ? null : round4(value * scale);
  }
  return row;
}

export function foodRow(food, meta, brandId) {
  return {
    publicId: food.public_id,
    brandId: brandId ?? null,
    name: food.name,
    normalizedName: food.normalized_name,
    baseName: food.base_name,
    nameSegments: food.name_segments,
    foodType: FOOD_TYPE,
    barcode: food.barcode,
    barcodeType: food.barcode_type,
    region: REGION,
    language: LANGUAGE,
    sourceName: meta.source_name,
    sourceRecordId: food.source_record_id,
    sourceLicense: meta.source_license,
    verificationStatus: VERIFICATION,
    isActive: true,
    updatedAt: new Date(),
  };
}

export function servingRow(foodId, profileId, serving, order) {
  return {
    foodId,
    nutritionProfileId: profileId,
    sourceRecordId: serving.source_record_id,
    description: serving.description,
    measurementDescription: serving.measurement_description,
    numberOfUnits: serving.number_of_units,
    metricAmount: round4(serving.grams_equivalent),
    metricUnit: 'g',
    gramsEquivalent: round4(serving.grams_equivalent),
    millilitresEquivalent: serving.millilitres_equivalent,
    isDefault: serving.is_default,
    sortOrder: order,
    updatedAt: new Date(),
  };
}

/** Upsert every brand once, up front, and return normalized_name -> id. */
async function loadBrands(tx, brands, report) {
  const byName = new Map();
  for (let i = 0; i < brands.length; i += 500) {
    const rows = await tx
      .insert(catalogBrandsTable)
      .values(brands.slice(i, i + 500).map((b) => ({
        name: b.name,
        normalizedName: b.normalized_name,
        updatedAt: new Date(),
      })))
      .onConflictDoUpdate({
        target: catalogBrandsTable.normalizedName,
        set: { name: sql`excluded.name`, updatedAt: sql`now()` },
      })
      .returning({ id: catalogBrandsTable.id, normalizedName: catalogBrandsTable.normalizedName });
    for (const r of rows) byName.set(r.normalizedName, r.id);
  }
  report.brands = byName.size;
  return byName;
}

async function importChunk(tx, foods, meta, brandIds, report) {
  const upserted = await tx
    .insert(catalogFoodsTable)
    .values(foods.map((f) => foodRow(f, meta, brandIds.get((f.brands[0] || '').toLowerCase()))))
    .onConflictDoUpdate({
      target: [catalogFoodsTable.sourceName, catalogFoodsTable.sourceRecordId],
      set: {
        name: sql`excluded.name`,
        normalizedName: sql`excluded.normalized_name`,
        baseName: sql`excluded.base_name`,
        brandId: sql`excluded.brand_id`,
        barcode: sql`excluded.barcode`,
        barcodeType: sql`excluded.barcode_type`,
        sourceLicense: sql`excluded.source_license`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: catalogFoodsTable.id, sourceRecordId: catalogFoodsTable.sourceRecordId });

  const idBySource = new Map(upserted.map((r) => [r.sourceRecordId, r.id]));
  const foodIds = upserted.map((r) => r.id);

  const existing = await tx
    .select({
      id: catalogFoodServingsTable.id,
      foodId: catalogFoodServingsTable.foodId,
      sourceRecordId: catalogFoodServingsTable.sourceRecordId,
      nutritionProfileId: catalogFoodServingsTable.nutritionProfileId,
    })
    .from(catalogFoodServingsTable)
    .where(inArray(catalogFoodServingsTable.foodId, foodIds));
  const known = new Map(existing.map((r) => [key(r.foodId, r.sourceRecordId), r]));

  // The partial UNIQUE(food_id) WHERE is_default index is checked per statement
  // and cannot be deferred, so clear defaults before writing any serving.
  if (known.size) {
    await tx
      .update(catalogFoodServingsTable)
      .set({ isDefault: false })
      .where(inArray(catalogFoodServingsTable.foodId, foodIds));
  }

  const planned = [];
  for (const food of foods) {
    const foodId = idBySource.get(food.source_record_id);
    food.servings.forEach((serving, order) => {
      planned.push({
        update: known.get(key(foodId, serving.source_record_id)) || null,
        profile: profileFor(food, serving, meta),
        serving,
        foodId,
        order,
      });
    });
  }

  const inserts = planned.filter((p) => !p.update);
  const updates = planned.filter((p) => p.update);

  if (inserts.length) {
    const profileIds = await tx
      .insert(nutritionProfilesTable)
      .values(inserts.map((p) => p.profile))
      .returning({ id: nutritionProfilesTable.id });
    if (profileIds.length !== inserts.length) {
      throw new Error(`profile insert returned ${profileIds.length} of ${inserts.length}`);
    }
    await tx.insert(catalogFoodServingsTable).values(
      inserts.map((p, i) => servingRow(p.foodId, profileIds[i].id, p.serving, p.order)),
    );
    report.servingsInserted += inserts.length;
  }

  for (const p of updates) {
    await tx
      .update(nutritionProfilesTable)
      .set(p.profile)
      .where(sql`${nutritionProfilesTable.id} = ${p.update.nutritionProfileId}`);
    const row = servingRow(p.foodId, p.update.nutritionProfileId, p.serving, p.order);
    delete row.foodId;
    delete row.nutritionProfileId;
    await tx
      .update(catalogFoodServingsTable)
      .set(row)
      .where(sql`${catalogFoodServingsTable.id} = ${p.update.id}`);
    report.servingsUpdated += 1;
  }

  report.foods += foods.length;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) : Infinity;

  const payload = JSON.parse(readFileSync(JSON_PATH, 'utf-8'));
  const meta = {
    source_name: payload.source_name,
    source_license: payload.source_license,
    basis_state: payload.basis_state,
    carbohydrate_basis: payload.carbohydrate_basis,
    vitamin_a_convention: payload.vitamin_a_convention,
  };
  for (const k of ['source_name', 'source_license', 'basis_state', 'carbohydrate_basis']) {
    if (!meta[k]) throw new Error(`off_au.json is missing "${k}" - regenerate it with extract.py`);
  }

  const foods = payload.foods.slice(0, limit);
  // Only the brands this run actually references, so --limit stays cheap.
  const referenced = new Set(foods.flatMap((f) => f.brands.map((b) => b.toLowerCase())));
  const brands = payload.brands.filter((b) => referenced.has(b.normalized_name));

  console.log(`Loading ${foods.length.toLocaleString()} products from ${path.basename(JSON_PATH)}`);
  console.log(`  generated ${payload.generated_at}`);
  console.log(`  ${meta.source_name} | ${meta.source_license} | basis=${meta.basis_state} `
    + `carbs=${meta.carbohydrate_basis} vitA=${meta.vitamin_a_convention ?? 'null'}`);
  console.log(`  ${brands.length.toLocaleString()} brands referenced`);
  if (dryRun) console.log('  DRY RUN - the transaction is rolled back at the end\n');

  const report = { foods: 0, brands: 0, servingsInserted: 0, servingsUpdated: 0, skipped: [] };
  const pool = new Pool({ connectionString: ENV.DB_URL });
  const db = drizzle(pool);
  const started = Date.now();

  const progress = () => process.stdout.write(
    `\r  ${report.foods}/${foods.length} products, `
    + `${report.servingsInserted + report.servingsUpdated} servings`);

  try {
    if (dryRun) {
      // One transaction so the whole thing can be rolled back and inspected.
      await db.transaction(async (tx) => {
        const brandIds = await loadBrands(tx, brands, report);
        for (let i = 0; i < foods.length; i += CHUNK) {
          await importChunk(tx, foods.slice(i, i + CHUNK), meta, brandIds, report);
          progress();
        }
        throw new Rollback();
      });
    } else {
      // Per-chunk commits. The full load runs ~10 minutes, and holding one
      // transaction open that long risks losing all of it to a timeout for no
      // benefit: each chunk is already atomic, so a food can never land without
      // its nutrition, and the import is idempotent so a re-run resumes.
      const brandIds = await db.transaction((tx) => loadBrands(tx, brands, report));
      for (let i = 0; i < foods.length; i += CHUNK) {
        const slice = foods.slice(i, i + CHUNK);
        await db.transaction((tx) => importChunk(tx, slice, meta, brandIds, report));
        progress();
      }
    }
  } catch (e) {
    if (!(e instanceof Rollback)) {
      const scope = dryRun
        ? 'the transaction rolled back, nothing was written'
        : `stopped after ${report.foods.toLocaleString()} products; committed chunks remain, re-run to resume`;
      console.error(`\n\nFAILED - ${scope}.\n${e.message}`);
      await pool.end();
      process.exit(1);
    }
  }

  console.log(`\n\nReport (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(`  brands upserted   : ${report.brands.toLocaleString()}`);
  console.log(`  products processed: ${report.foods.toLocaleString()}`);
  console.log(`  servings inserted : ${report.servingsInserted.toLocaleString()}`);
  console.log(`  servings updated  : ${report.servingsUpdated.toLocaleString()}`);
  console.log(`  servings skipped  : ${report.skipped.length.toLocaleString()}`);

  if (!dryRun) {
    const counts = await db.execute(sql`
      select (select count(*) from catalog_foods where source_name = ${meta.source_name}) as off_foods,
             (select count(*) from catalog_foods where source_name = 'ausnut_2023')       as ausnut_foods,
             (select count(*) from catalog_brands)                                        as brands,
             (select count(*) from catalog_food_servings)                                 as servings,
             (select count(*) from nutrition_profiles)                                    as profiles,
             (select count(*) from catalog_foods where barcode is not null)               as with_barcode`);
    const c = counts.rows[0];
    console.log(`\nIn the database now:`);
    for (const [label, value] of [
      ['catalog_foods (openfoodfacts)', c.off_foods],
      ['catalog_foods (ausnut_2023)', c.ausnut_foods],
      ['catalog_brands', c.brands],
      ['catalog_food_servings', c.servings],
      ['nutrition_profiles', c.profiles],
      ['foods carrying a barcode', c.with_barcode],
    ]) console.log(`  ${label.padEnd(30)} ${Number(value).toLocaleString()}`);
  } else {
    console.log('\nRolled back - nothing was written.');
  }

  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
