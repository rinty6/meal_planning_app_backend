/**
 * Stage 2 of the AUSNUT import: read tools/ausnut_extract/out/ausnut.json and
 * write catalog_foods + nutrition_profiles + catalog_food_servings.
 *
 * Stage 1 (tools/ausnut_extract/extract.py) owns every spreadsheet quirk and
 * unit trap; this file owns the database and nothing else. Verify the JSON with
 * verify.py BEFORE running this - it is the gate, not this script.
 *
 *   node importers/ausnut/load.js --dry-run        # rolls back, prints the report
 *   node importers/ausnut/load.js --limit 50       # first 50 foods only
 *   node importers/ausnut/load.js                  # real import
 *
 * Idempotent (checklist p2-24): foods upsert on (source_name, source_record_id),
 * servings on (food_id, source_record_id). Re-running updates in place and never
 * duplicates or churns ids.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { inArray, sql } from 'drizzle-orm';

import { ENV } from '../../src/config/env.js';
import {
  catalogFoodsTable,
  catalogFoodServingsTable,
  nutritionProfilesTable,
} from '../../src/db/food_schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.resolve(HERE, '../../../tools/ausnut_extract/out/ausnut.json');

const REGION = 'AU';
const LANGUAGE = 'en-AU';
const FOOD_TYPE = 'generic';          // AUSNUT is the generic backbone; OFF brings branded
const VERIFICATION = 'unverified';    // nothing has been eyeballed by a human yet

// A sentinel rather than NULL so the synthesised serving still participates in
// the UNIQUE(food_id, source_record_id) index. With NULL it would insert a
// duplicate on every re-run, because Postgres treats NULLs as distinct.
const SYNTHETIC_100G = 'synthetic:100g';

const CHUNK = 100;

// JSON nutrient key -> Drizzle column on nutrition_profiles.
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
const key = (foodId, sourceRecordId) => `${foodId}\u0000${sourceRecordId}`;

class Rollback extends Error {}

/**
 * The servings to write for a food. AUSNUT covers only 2,618 of 3,741 foods
 * with real measures; the rest get one synthesised 100 g serving, which is the
 * documented policy ("synthesise a 100 g serving when no portion exists") and
 * not a per-food guess.
 *
 * is_default goes to the FIRST AUSNUT measure: the source orders them small to
 * large and the first is reliably a single natural unit ("1 wrap, regular").
 */
export function servingsFor(food) {
  if (food.servings.length) {
    return food.servings.map((s, i) => ({ ...s, isDefault: i === 0 }));
  }
  return [{
    source_record_id: SYNTHETIC_100G,
    description: '100 g',
    measurement_description: 'g',
    number_of_units: 100,
    grams_equivalent: 100,
    millilitres_equivalent: null,
    isDefault: true,
  }];
}

/**
 * AUSNUT nutrients are per 100 g, so every serving's profile is those values
 * scaled by grams/100. basis_quantity records the grams this profile describes,
 * which is what makes the row self-describing rather than implicitly per-100 g.
 */
export function profileFor(food, serving, meta) {
  const scale = serving.grams_equivalent / 100;
  const row = {
    basisQuantity: round4(serving.grams_equivalent),
    basisUnit: 'g',
    basisState: meta.basis_state,
    carbohydrateBasis: meta.carbohydrate_basis,
    vitaminAConvention: meta.vitamin_a_convention,
    calculationMethod: 'scaled_from_per_100g',
    sourceName: meta.source_name,
    sourceLicense: meta.source_license,
    sourceDerivation: food.source_derivation,
  };
  for (const [jsonKey, column] of Object.entries(NUTRIENT_COLUMNS)) {
    const value = food.nutrients[jsonKey];
    // Absent stays NULL. Unknown is not zero, and the schema is built for that.
    row[column] = value === undefined || value === null ? null : round4(value * scale);
  }
  return row;
}

function foodRow(food, meta) {
  return {
    publicId: food.public_id,
    name: food.name,
    normalizedName: food.normalized_name,
    baseName: food.base_name,
    nameSegments: food.name_segments,
    foodType: FOOD_TYPE,
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

function servingRow(foodId, profileId, serving, order) {
  return {
    foodId,
    nutritionProfileId: profileId,
    sourceRecordId: serving.source_record_id,
    description: serving.description,
    measurementDescription: serving.measurement_description,
    numberOfUnits: serving.number_of_units,
    metricAmount: serving.grams_equivalent === null ? null : round4(serving.grams_equivalent),
    metricUnit: serving.grams_equivalent === null ? null : 'g',
    gramsEquivalent: serving.grams_equivalent === null ? null : round4(serving.grams_equivalent),
    millilitresEquivalent: serving.millilitres_equivalent,
    isDefault: serving.isDefault,
    sortOrder: order,
    updatedAt: new Date(),
  };
}

async function importChunk(tx, foods, meta, report) {
  const upserted = await tx
    .insert(catalogFoodsTable)
    .values(foods.map((f) => foodRow(f, meta)))
    .onConflictDoUpdate({
      target: [catalogFoodsTable.sourceName, catalogFoodsTable.sourceRecordId],
      set: {
        name: sql`excluded.name`,
        normalizedName: sql`excluded.normalized_name`,
        baseName: sql`excluded.base_name`,
        nameSegments: sql`excluded.name_segments`,
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

  // Clear defaults first. The partial UNIQUE(food_id) WHERE is_default is
  // checked per statement, so flipping one serving's default while another
  // still holds it would trip the index mid-transaction.
  if (known.size) {
    await tx
      .update(catalogFoodServingsTable)
      .set({ isDefault: false })
      .where(inArray(catalogFoodServingsTable.foodId, foodIds));
  }

  const fresh = [];
  for (const food of foods) {
    const foodId = idBySource.get(food.source_record_id);
    servingsFor(food).forEach((serving, order) => {
      if (serving.grams_equivalent === null) {
        report.skipped.push(`${food.source_record_id}: "${serving.description}" has no gram amount`);
        return;
      }
      const profile = profileFor(food, serving, meta);
      const hit = known.get(key(foodId, serving.source_record_id));
      if (hit) {
        fresh.push({ update: hit, profile, serving, foodId, order });
      } else {
        fresh.push({ update: null, profile, serving, foodId, order });
      }
    });
  }

  const inserts = fresh.filter((f) => !f.update);
  const updates = fresh.filter((f) => f.update);

  if (inserts.length) {
    // Multi-row INSERT ... RETURNING comes back in the order supplied, which is
    // what lets us pair profile ids to servings positionally.
    const profileIds = await tx
      .insert(nutritionProfilesTable)
      .values(inserts.map((f) => f.profile))
      .returning({ id: nutritionProfilesTable.id });
    if (profileIds.length !== inserts.length) {
      throw new Error(`profile insert returned ${profileIds.length} of ${inserts.length}`);
    }
    await tx.insert(catalogFoodServingsTable).values(
      inserts.map((f, i) => servingRow(f.foodId, profileIds[i].id, f.serving, f.order)),
    );
    report.servingsInserted += inserts.length;
  }

  for (const f of updates) {
    await tx
      .update(nutritionProfilesTable)
      .set(f.profile)
      .where(sql`${nutritionProfilesTable.id} = ${f.update.nutritionProfileId}`);
    const row = servingRow(f.foodId, f.update.nutritionProfileId, f.serving, f.order);
    delete row.foodId;
    delete row.nutritionProfileId;
    await tx
      .update(catalogFoodServingsTable)
      .set(row)
      .where(sql`${catalogFoodServingsTable.id} = ${f.update.id}`);
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
  for (const [k, v] of Object.entries(meta)) {
    if (!v) throw new Error(`ausnut.json is missing "${k}" - regenerate it with extract.py`);
  }

  const foods = payload.foods.slice(0, limit);
  console.log(`Loading ${foods.length.toLocaleString()} foods from ${path.basename(JSON_PATH)}`);
  console.log(`  generated ${payload.generated_at}`);
  console.log(`  ${meta.source_name} | ${meta.source_license} | basis=${meta.basis_state} `
    + `carbs=${meta.carbohydrate_basis} vitA=${meta.vitamin_a_convention}`);
  if (dryRun) console.log('  DRY RUN - the transaction is rolled back at the end\n');

  const report = { foods: 0, servingsInserted: 0, servingsUpdated: 0, skipped: [] };
  const pool = new Pool({ connectionString: ENV.DB_URL });
  const db = drizzle(pool);
  const started = Date.now();

  try {
    await db.transaction(async (tx) => {
      for (let i = 0; i < foods.length; i += CHUNK) {
        await importChunk(tx, foods.slice(i, i + CHUNK), meta, report);
        const done = Math.min(i + CHUNK, foods.length);
        process.stdout.write(`\r  ${done}/${foods.length} foods, `
          + `${report.servingsInserted + report.servingsUpdated} servings`);
      }
      if (dryRun) throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) {
      console.error(`\n\nFAILED - the transaction rolled back, nothing was written.\n${e.message}`);
      await pool.end();
      process.exit(1);
    }
  }

  // Checklist p2-25: without a report you cannot tell a clean import from a
  // silently half-finished one.
  console.log(`\n\nReport (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(`  foods processed   : ${report.foods.toLocaleString()}`);
  console.log(`  servings inserted : ${report.servingsInserted.toLocaleString()}`);
  console.log(`  servings updated  : ${report.servingsUpdated.toLocaleString()}`);
  console.log(`  servings skipped  : ${report.skipped.length.toLocaleString()}`);
  for (const s of report.skipped.slice(0, 10)) console.log(`      ${s}`);

  if (!dryRun) {
    const counts = await db.execute(sql`
      select (select count(*) from catalog_foods where source_name = ${meta.source_name}) as foods,
             (select count(*) from catalog_food_servings) as servings,
             (select count(*) from nutrition_profiles)    as profiles,
             (select count(*) from catalog_food_servings where is_default) as defaults`);
    const c = counts.rows[0];
    console.log(`\nIn the database now:`);
    console.log(`  catalog_foods (${meta.source_name}) : ${Number(c.foods).toLocaleString()}`);
    console.log(`  catalog_food_servings             : ${Number(c.servings).toLocaleString()}`);
    console.log(`  nutrition_profiles                : ${Number(c.profiles).toLocaleString()}`);
    console.log(`  servings marked default           : ${Number(c.defaults).toLocaleString()}`);
  } else {
    console.log('\nRolled back - nothing was written.');
  }

  await pool.end();
}

// Only run when invoked directly, so the pure helpers above can be imported by
// a test without kicking off an import as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
