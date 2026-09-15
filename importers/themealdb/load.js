/**
 * TheMealDB recipe import, STAGE 3 step 2: load into Neon.
 *
 * Reads three JSON inputs, all produced by earlier read-only stages:
 *   tools/themealdb_extract/out/themealdb.json   recipes, steps, ingredients
 *   out/recipe_nutrition.json                    per-serving nutrition (compute.js)
 *   out/ingredient_map.json                      ingredient -> catalog food (resolve.js)
 *
 * Writes catalog_recipes + nutrition_profiles + recipe_ingredients + recipe_steps.
 * Taxonomy (strCategory / strArea / strTags) is deliberately NOT loaded here;
 * it gets its own file, the way load_categories.js is kept separate from
 * load.js for AUSNUT, so this loader stays proven and unmodified when the
 * taxonomy is re-seeded.
 *
 *   node importers/themealdb/load.js --dry-run     (from backend/)
 *   node importers/themealdb/load.js
 *   node importers/themealdb/load.js --limit 20
 *
 * MUST be run from backend/ - dotenv resolves .env from process.cwd().
 *
 * Uses Pool + drizzle-orm/neon-serverless, NOT the neon-http driver in
 * src/config/db.js, which has no interactive transactions.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';

import { ENV } from '../../src/config/env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IN_RECIPES = path.resolve(HERE, '../../../tools/themealdb_extract/out/themealdb.json');
const IN_NUTRITION = path.resolve(HERE, 'out/recipe_nutrition.json');
const IN_MAP = path.resolve(HERE, 'out/ingredient_map.json');

export const SOURCE_NAME = 'themealdb';
export const SOURCE_LICENSE = 'TheMealDB-ToS';

export const NUTRIENTS = [
  'calories_kcal', 'energy_kj', 'protein_g', 'carbohydrate_g', 'fat_g',
  'saturated_fat_g', 'trans_fat_g', 'polyunsaturated_fat_g',
  'monounsaturated_fat_g', 'cholesterol_mg', 'sodium_mg', 'potassium_mg',
  'fiber_g', 'sugar_g', 'added_sugars_g', 'vitamin_d_mcg', 'calcium_mg',
  'iron_mg', 'vitamin_a_mcg', 'vitamin_c_mg',
];

// ---------------------------------------------------------------------------
// Pure row builders. Exported so load.test.js can assert on them with no
// database at all, which is the same split ausnut/load.test.js uses.
// ---------------------------------------------------------------------------

export const publicIdFor = (sourceRecordId) => `recipe_${SOURCE_NAME}_${sourceRecordId}`;

/**
 * The recipe's own nutrition profile. basis_quantity is GRAMS PER SERVING, not
 * 100, because catalog_recipes.nutrition_basis is fixed at 'per_serving' by a
 * CHECK and whole-recipe totals are derived as per-serving x yield_servings.
 *
 * basis_state is 'prepared': the row describes a portion of a finished dish.
 * The honest caveat, recorded in compute.js, is that the mass is summed RAW
 * ingredient mass with no cooking water loss modelled; servings_estimated on
 * the recipe row is what flags that.
 *
 * source_derivation is 'recipe', which is exactly what the tier means: a value
 * computed from a recipe rather than measured. It also makes these rows sort
 * below lab-analysed AUSNUT foods in the search ranking, which is correct.
 *
 * confidence carries covered_mass_fraction. The column is numeric(5,4) in 0..1
 * and this is precisely the kind of thing it exists for: how much of the dish
 * the numbers actually account for.
 */
export const buildProfileRow = (n) => {
  const row = {
    basis_quantity: n.grams_per_serving,
    basis_unit: 'g',
    basis_state: 'prepared',
    carbohydrate_basis: n.carbohydrate_basis,
    vitamin_a_convention: n.vitamin_a_convention,
    calculation_method: 'ingredient_calculation',
    confidence: n.covered_mass_fraction,
    source_name: SOURCE_NAME,
    source_license: SOURCE_LICENSE,
    source_derivation: 'recipe',
  };
  for (const k of NUTRIENTS) {
    // unknown stays NULL. compute.js already refuses to sum a nutrient any
    // covered ingredient lacks, so a null here is a real unknown, not a zero.
    row[k] = n.per_serving[k] === undefined ? null : n.per_serving[k];
  }
  return row;
};

export const buildRecipeRow = (r, n, profileId) => ({
  public_id: publicIdFor(r.source_record_id),
  nutrition_profile_id: profileId,
  title: r.title,
  normalized_title: r.normalized_title,
  description: null,
  yield_servings: n.yield_servings,
  servings_estimated: true,
  grams_per_serving: n.grams_per_serving,
  total_weight_g: n.total_weight_g,
  nutrition_basis: 'per_serving',
  // TheMealDB publishes neither. Nullable on purpose so we never store a fake
  // zero, which is the parseInt(x) || 0 bug the schema comment warns about.
  prep_time_min: null,
  cook_time_min: null,
  primary_image_url: r.image_url ?? null,
  rating: null,
  source_name: SOURCE_NAME,
  source_record_id: r.source_record_id,
  source_license: SOURCE_LICENSE,
  verification_status: 'unverified',
  is_active: true,
});

/**
 * food_id is set ONLY for high|medium matches, matching what compute.js summed.
 * A low match is fuzzy-only and a wrong food_id is worse than none, which is
 * why the column was made nullable in the 2026-08-16 schema revision.
 *
 * food_serving_id stays NULL throughout. We compute from per-100 g values, not
 * from a named serving, so there is no serving to point at. That also means the
 * composite (food_serving_id, food_id) FK never fires.
 *
 * quantity is NOT NULL and there is no unit column on this table, so it holds
 * the gram amount and display_text keeps the human measure ("500g", "1 tbsp").
 */
export const buildIngredientRows = (r, imap, recipeId) => r.ingredients.map((ing) => {
  const e = imap[ing.name.trim().toLowerCase()];
  const usable = e && (e.confidence === 'high' || e.confidence === 'medium');
  const grams = ing.grams === null || ing.grams === undefined ? 0 : Number(ing.grams);
  const measure = String(ing.measure ?? '').trim();
  return {
    recipe_id: recipeId,
    food_id: usable ? Number(e.food_id) : null,
    food_serving_id: null,
    position: ing.position,
    quantity: grams,
    gram_weight: grams,
    display_text: measure ? `${measure} ${ing.name}`.trim() : ing.name,
    preparation_note: ing.grams_low_confidence ? 'amount estimated from source text' : null,
  };
});

export const buildStepRows = (r, recipeId) => r.steps.map((instruction, i) => ({
  recipe_id: recipeId,
  step_number: i + 1,
  instruction,
  duration_min: null,
  image_url: null,
}));

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const lit = (v) => {
  if (v === null || v === undefined) return sql`null`;
  return sql`${v}`;
};

async function main() {
  const DRY = process.argv.includes('--dry-run');
  const li = process.argv.indexOf('--limit');
  const LIMIT = li > -1 ? Number(process.argv[li + 1]) : Infinity;
  const CHUNK = 50;

  const pool = new Pool({ connectionString: ENV.DB_URL });
  const db = drizzle(pool);

  try {
    const payload = JSON.parse(readFileSync(IN_RECIPES, 'utf-8'));
    const nutrition = JSON.parse(readFileSync(IN_NUTRITION, 'utf-8'));
    const imap = JSON.parse(readFileSync(IN_MAP, 'utf-8')).map;

    const byId = new Map(nutrition.recipes.map((n) => [n.source_record_id, n]));
    const recipes = payload.recipes.filter((r) => byId.has(r.source_record_id)).slice(0, LIMIT);
    if (recipes.length !== payload.recipes.length && LIMIT === Infinity) {
      throw new Error(`recipe_nutrition.json covers ${byId.size} of ${payload.recipes.length}`
        + ' recipes. Re-run compute.js before loading.');
    }

    console.log(`${DRY ? 'DRY RUN: ' : ''}loading ${recipes.length} recipes`
      + ` (divisor ${nutrition.racc_divisor_g} g, carb basis ${nutrition.carbohydrate_basis})`);

    let recipesWritten = 0;
    let ingredientsWritten = 0;
    let stepsWritten = 0;
    let ingredientsUnmapped = 0;
    const t0 = Date.now();

    for (let start = 0; start < recipes.length; start += CHUNK) {
      const chunk = recipes.slice(start, start + CHUNK);
      // Per-chunk transaction. Each chunk is atomic, so a recipe can never land
      // without its nutrition profile, and a re-run resumes rather than
      // restarting. --dry-run rolls the whole chunk back.
      await db.transaction(async (tx) => {
        // One SELECT for the whole chunk. At roughly 200 ms of round trip per
        // query from a laptop to Neon, per-row queries dominate the runtime
        // completely; this and the multi-row INSERTs below are what take the
        // load from ~35 minutes to a few minutes.
        const priorRes = await tx.execute(sql`
          select id, nutrition_profile_id, source_record_id from catalog_recipes
          where source_name = ${SOURCE_NAME}
            and source_record_id in (${sql.join(chunk.map((r) => sql`${r.source_record_id}`), sql`, `)})`);
        const priorMap = new Map((priorRes.rows ?? priorRes).map((x) => [x.source_record_id, x]));

        for (const r of chunk) {
          const n = byId.get(r.source_record_id);
          const prior = priorMap.get(r.source_record_id);

          const p = buildProfileRow(n);
          const nutrientCols = NUTRIENTS.map((k) => sql.raw(k));
          const nutrientVals = NUTRIENTS.map((k) => lit(p[k]));

          let profileId;
          if (prior) {
            // Update in place so the recipe keeps its id and its 1:1 profile,
            // which the UNIQUE on nutrition_profile_id requires.
            profileId = Number(prior.nutrition_profile_id);
            const sets = NUTRIENTS.map((k) => sql`${sql.raw(k)} = ${lit(p[k])}`);
            await tx.execute(sql`
              update nutrition_profiles set
                basis_quantity = ${p.basis_quantity}, basis_unit = ${p.basis_unit},
                basis_state = ${p.basis_state}, carbohydrate_basis = ${p.carbohydrate_basis},
                vitamin_a_convention = ${lit(p.vitamin_a_convention)},
                calculation_method = ${p.calculation_method}, confidence = ${p.confidence},
                source_name = ${p.source_name}, source_license = ${p.source_license},
                source_derivation = ${p.source_derivation},
                ${sql.join(sets, sql`, `)}
              where id = ${profileId}`);
          } else {
            const ins = await tx.execute(sql`
              insert into nutrition_profiles
                (basis_quantity, basis_unit, basis_state, carbohydrate_basis,
                 vitamin_a_convention, calculation_method, confidence,
                 source_name, source_license, source_derivation,
                 ${sql.join(nutrientCols, sql`, `)})
              values
                (${p.basis_quantity}, ${p.basis_unit}, ${p.basis_state}, ${p.carbohydrate_basis},
                 ${lit(p.vitamin_a_convention)}, ${p.calculation_method}, ${p.confidence},
                 ${p.source_name}, ${p.source_license}, ${p.source_derivation},
                 ${sql.join(nutrientVals, sql`, `)})
              returning id`);
            profileId = Number((ins.rows ?? ins)[0].id);
          }

          const rec = buildRecipeRow(r, n, profileId);
          let recipeId;
          if (prior) {
            recipeId = Number(prior.id);
            await tx.execute(sql`
              update catalog_recipes set
                title = ${rec.title}, normalized_title = ${rec.normalized_title},
                yield_servings = ${rec.yield_servings},
                servings_estimated = ${rec.servings_estimated},
                grams_per_serving = ${rec.grams_per_serving},
                total_weight_g = ${rec.total_weight_g},
                primary_image_url = ${lit(rec.primary_image_url)},
                verification_status = ${rec.verification_status},
                is_active = ${rec.is_active}, updated_at = now()
              where id = ${recipeId}`);
          } else {
            const ins = await tx.execute(sql`
              insert into catalog_recipes
                (public_id, nutrition_profile_id, title, normalized_title, description,
                 yield_servings, servings_estimated, grams_per_serving, total_weight_g,
                 nutrition_basis, prep_time_min, cook_time_min, primary_image_url, rating,
                 source_name, source_record_id, source_license, verification_status, is_active)
              values
                (${rec.public_id}, ${profileId}, ${rec.title}, ${rec.normalized_title},
                 ${lit(rec.description)}, ${rec.yield_servings}, ${rec.servings_estimated},
                 ${rec.grams_per_serving}, ${rec.total_weight_g}, ${rec.nutrition_basis},
                 ${lit(rec.prep_time_min)}, ${lit(rec.cook_time_min)},
                 ${lit(rec.primary_image_url)}, ${lit(rec.rating)},
                 ${rec.source_name}, ${rec.source_record_id}, ${rec.source_license},
                 ${rec.verification_status}, ${rec.is_active})
              returning id`);
            recipeId = Number((ins.rows ?? ins)[0].id);
          }
          recipesWritten += 1;

          // Children are replaced wholesale rather than diffed. They are pure
          // derivations of the source JSON with no identity worth preserving,
          // and delete+insert keeps the UNIQUE(recipe_id, position) and
          // UNIQUE(recipe_id, step_number) indexes trivially satisfied on a
          // re-run where the source added or removed a row.
          if (prior) {
            await tx.execute(sql`delete from recipe_ingredients where recipe_id = ${recipeId}`);
            await tx.execute(sql`delete from recipe_steps where recipe_id = ${recipeId}`);
          }

          // Multi-row INSERTs. One statement per child table per recipe rather
          // than one per row: 5,005 ingredient round trips become 472.
          const ingRows = buildIngredientRows(r, imap, recipeId);
          if (ingRows.length) {
            const values = ingRows.map((ing) => {
              if (ing.food_id === null) ingredientsUnmapped += 1;
              return sql`(${ing.recipe_id}, ${lit(ing.food_id)}, null, ${ing.position},
                          ${ing.quantity}, ${ing.gram_weight}, ${ing.display_text},
                          ${lit(ing.preparation_note)})`;
            });
            await tx.execute(sql`
              insert into recipe_ingredients
                (recipe_id, food_id, food_serving_id, position, quantity, gram_weight,
                 display_text, preparation_note)
              values ${sql.join(values, sql`, `)}`);
            ingredientsWritten += ingRows.length;
          }

          const stepRows = buildStepRows(r, recipeId);
          if (stepRows.length) {
            const values = stepRows.map((st) => sql`(${st.recipe_id}, ${st.step_number},
                                                     ${st.instruction}, null, null)`);
            await tx.execute(sql`
              insert into recipe_steps (recipe_id, step_number, instruction, duration_min, image_url)
              values ${sql.join(values, sql`, `)}`);
            stepsWritten += stepRows.length;
          }
        }

        if (DRY) {
          // Rolling back inside the transaction callback is how drizzle wants a
          // dry run expressed; the throw is caught immediately below.
          throw new DryRunRollback();
        }
      }).catch((e) => {
        if (e instanceof DryRunRollback) return;
        throw e;
      });

      process.stdout.write(`\r  ${Math.min(start + CHUNK, recipes.length)}/${recipes.length}`
        + ` recipes  ${((Date.now() - t0) / 1000).toFixed(1)}s   `);
    }

    // The progress line above rewrites itself with \r, exactly like the AUSNUT
    // loader. It is not hung; let it finish.
    console.log('');
    console.log('');
    console.log(`  recipes              ${recipesWritten}`);
    console.log(`  recipe_ingredients   ${ingredientsWritten}  (${ingredientsUnmapped} with food_id NULL)`);
    console.log(`  recipe_steps         ${stepsWritten}`);
    console.log(`  elapsed              ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (DRY) console.log('');
    if (DRY) console.log('  DRY RUN - every chunk was rolled back, nothing was written.');
  } catch (err) {
    console.error('');
    console.error('LOAD FAILED:', err && err.message ? err.message : err);
    let c = err && err.cause;
    while (c) { console.error('  caused by:', c.code || '', c.message || c); c = c.cause; }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

class DryRunRollback extends Error {}

// Only connect when run directly, so load.test.js can import the pure builders
// without opening a database connection.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
