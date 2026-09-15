/**
 * TheMealDB recipe import, STAGE 3 step 1: nutrition computation.
 *
 * Reads the two stage-1/2 outputs and the catalogue, and computes one
 * per-serving nutrition figure per recipe. Writes JSON only. It performs NO
 * database writes and opens no transaction, so it is safe to run repeatedly
 * while calibrating. load.js consumes its output.
 *
 * This mirrors the shape that worked for ausnut and off: a pure computation
 * step whose output can be inspected and re-derived before anything is loaded.
 *
 *   node importers/themealdb/compute.js            (from backend/)
 *   node importers/themealdb/compute.js --verbose
 *   node importers/themealdb/compute.js --divisor 250
 *
 * MUST be run from backend/ - dotenv resolves .env from process.cwd(), so
 * running it from this folder leaves ENV.DB_URL undefined and every query dies
 * with "No database host or connection string was set".
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';

import { ENV } from '../../src/config/env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IN_RECIPES = path.resolve(HERE, '../../../tools/themealdb_extract/out/themealdb.json');
const IN_MAP = path.resolve(HERE, 'out/ingredient_map.json');
const OUT_DIR = path.resolve(HERE, 'out');

const VERBOSE = process.argv.includes('--verbose');
const argDivisor = process.argv.indexOf('--divisor');

/**
 * FDA RACC (21 CFR 101.12 Table 2) gives "1 cup" for mixed dishes measurable
 * with a cup, which is about 250 g. Australia has no equivalent fixed figure:
 * FSANZ requires per-serving and per-100 g on the label but leaves the serving
 * size to the manufacturer. Deriving a divisor from our own AUSNUT data was
 * tried and failed honestly - the only mixed-dish measures left after removing
 * the importer's own synthetic 100 g servings were whole cans, a packaging unit
 * rather than a portion. So RACC is the starting point, not a measured one,
 * and the point of printing the per-serving energy distribution below is to let
 * a human confirm or move it.
 *
 * CALIBRATED 2026-09-09 to 300, from RACC's 250. Two independent lines of reasoning
 * agreed, which is why it moved:
 *
 * 1. Physical. RACC 250 g describes a COOKED portion. total_weight_g here is
 *    RAW mass, and cooking drives off water, so raw_mass / 250 systematically
 *    creates too many servings. With a typical 15-25% water loss the honest
 *    divisor is 250 / 0.8, about 310.
 * 2. Measured. Sweeping 200-450 g, the share of recipes landing in a
 *    main-course band (1,500-4,000 kJ) is a FLAT optimum: 45.1% at 200, 54.2%
 *    at 250, 56.1% at 300, 58.5% at 350, 58.1% at 400, 55.1% at 450. The
 *    metric cannot separate 300 from 400, so it was used only to rule out the
 *    extremes, not to pick the winner. Median per-serving energy is the more
 *    readable signal: 1,856 kJ at 250 is light for a main course, 2,224 kJ
 *    (531 kcal) at 300 is right, 2,558 kJ at 350 is heavy.
 *
 * Sanity-checked against familiar dishes at 300: Beef Wellington 8 servings /
 * 744 kcal, Carbonara 3 / 559, Lasagne 9 / 524, Beef stroganoff 4 / 792.
 *
 * KNOWN FAILURE MODE, not fixable with a single mass divisor: dense desserts
 * get too few servings. Apple Frangipan Tart comes out at 3 servings and 1,156
 * kcal where a tart is really 8. A per-category divisor would fix it; TheMealDB
 * does carry strCategory, so that is the obvious v2 improvement.
 *
 * SECOND KNOWN BIAS: unmatched ingredients still count toward total_weight_g,
 * so they raise the serving count while adding no energy, depressing
 * per-serving values twice over. Corned Beef and Cabbage reads 376 kJ per
 * serving because its brisket is unmatched. Deliberately NOT corrected by
 * scaling energy up by 1 / coverage, which would invent data; the honest
 * signal is covered_mass_fraction, recorded on every recipe, and only 38 of
 * 472 recipes sit below 100%.
 */
const DIVISOR = argDivisor > -1 ? Number(process.argv[argDivisor + 1]) : 300;

/**
 * The 19 nutrients the app renders, plus energy_kj which sits alongside kcal
 * because AU labels are legally kJ and AUSNUT has no kcal column of its own.
 */
const NUTRIENTS = [
  'calories_kcal', 'energy_kj', 'protein_g', 'carbohydrate_g', 'fat_g',
  'saturated_fat_g', 'trans_fat_g', 'polyunsaturated_fat_g',
  'monounsaturated_fat_g', 'cholesterol_mg', 'sodium_mg', 'potassium_mg',
  'fiber_g', 'sugar_g', 'added_sugars_g', 'vitamin_d_mcg', 'calcium_mg',
  'iron_mg', 'vitamin_a_mcg', 'vitamin_c_mg',
];

// FSANZ Standard 1.2.8 energy factors, kJ per gram. The same constants
// catalog_audit uses, so a recipe and a food are judged the same way.
const KJ_PER_G = {
  protein: 17, fat: 37, carbohydrate: 16, fibre: 8,
};

const round4 = (n) => (n === null || n === undefined ? null : Math.round(n * 1e4) / 1e4);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.round((p / 100) * (s.length - 1));
  return s[Math.min(s.length - 1, Math.max(0, i))];
};

const pool = new Pool({ connectionString: ENV.DB_URL });
const db = drizzle(pool);

try {
  const payload = JSON.parse(readFileSync(IN_RECIPES, 'utf-8'));
  const imap = JSON.parse(readFileSync(IN_MAP, 'utf-8')).map;
  const recipes = payload.recipes;

  // Only high|medium feed nutrition. `low` means "fuzzy only, the ingredient
  // words are not all in the food name" and `none` means no match; both are
  // coverage gaps to be reported, not data to be summed.
  const usable = (k) => {
    const e = imap[k];
    return e && (e.confidence === 'high' || e.confidence === 'medium') ? e : null;
  };

  const foodIds = new Set();
  for (const r of recipes) {
    for (const ing of r.ingredients) {
      const e = usable(ing.name.trim().toLowerCase());
      if (e) foodIds.add(Number(e.food_id));
    }
  }
  console.log(`Recipes: ${recipes.length}, distinct catalogue foods referenced: ${foodIds.size}`);

  /**
   * Pull per-100 g values. nutrition_profiles rows are SCALED to their serving
   * (basis_quantity = that serving's grams), so the per-100 g figure has to be
   * recovered as value / basis_quantity * 100. Reading the column and treating
   * it as per-100 g would silently mis-scale every ingredient whose default
   * serving is not 100 g, which is most of them. This is the same scale factor
   * that ausnut/load.test.js guards with the 331.65 g can of beer.
   */
  const cols = NUTRIENTS.map((n) => `p.${n}`).join(', ');
  const res = await db.execute(sql.raw(
    'select f.id as food_id, f.name, p.basis_quantity, p.basis_state,'
    + ` p.carbohydrate_basis, p.vitamin_a_convention, p.source_name, ${cols}`
    + ' from catalog_foods f'
    + ' join catalog_food_servings s on s.food_id = f.id and s.is_default'
    + ' join nutrition_profiles p on p.id = s.nutrition_profile_id'
    + ` where f.id in (${[...foodIds].join(',')})`,
  ));
  const foodRows = res.rows ?? res;

  const per100 = new Map();
  const bases = new Set();
  const vitAConv = new Set();

  for (const r of foodRows) {
    const q = Number(r.basis_quantity);
    if (!(q > 0)) throw new Error(`food ${r.food_id} has basis_quantity ${r.basis_quantity}`);
    const v = {};
    for (const n of NUTRIENTS) {
      const raw = r[n];
      v[n] = raw === null || raw === undefined ? null : (Number(raw) / q) * 100;
    }
    per100.set(Number(r.food_id), { name: r.name, v });
    bases.add(r.carbohydrate_basis);
    if (r.vitamin_a_mcg !== null && r.vitamin_a_mcg !== undefined) {
      vitAConv.add(r.vitamin_a_convention === null ? 'null' : r.vitamin_a_convention);
    }
  }

  /**
   * Convention gates. These throw rather than warn, because a silently blended
   * carbohydrate basis produces a number that is neither convention and nothing
   * downstream could ever detect it. AUSNUT is available carbohydrate (excludes
   * fibre) and USDA is by difference (includes it); summing the two is exactly
   * the error the carbohydrate_basis column was added to make impossible.
   *
   * Same for vitamin A: RE and RAE differ by 2x on beta-carotene, and the
   * 2026-09-03 rule is never to blend or average across conventions.
   *
   * When USDA gap-fill lands, the fix is NOT to relax this. It is to normalise
   * by-difference rows to available carb (carb - fibre) as they are read, here,
   * and keep storing the source rows on their own true basis.
   */
  if (bases.size !== 1) {
    throw new Error(`MIXED carbohydrate_basis across ingredients: ${[...bases].join(', ')}. `
      + 'Normalise by_difference rows to available carb (carb - fibre) before summing.');
  }
  if (vitAConv.size > 1) {
    throw new Error(`MIXED vitamin_a_convention across ingredients: ${[...vitAConv].join(', ')}`);
  }
  const CARB_BASIS = [...bases][0];
  const VIT_A = vitAConv.size === 1 ? [...vitAConv][0] : null;
  console.log(`carbohydrate_basis: ${CARB_BASIS} (uniform), vitamin_a_convention: ${VIT_A}`);

  const out = [];
  const perServingKj = [];
  let missingFood = 0;

  for (const r of recipes) {
    let totalGrams = 0;
    let coveredGrams = 0;
    let lowConfGrams = 0;
    const sums = {};
    const missing = {};
    for (const n of NUTRIENTS) { sums[n] = 0; missing[n] = false; }
    const unmatched = [];

    for (const ing of r.ingredients) {
      const g = ing.grams === null || ing.grams === undefined ? 0 : Number(ing.grams);
      totalGrams += g;
      if (ing.grams_low_confidence) lowConfGrams += g;

      const e = usable(ing.name.trim().toLowerCase());
      if (!e) { unmatched.push({ name: ing.name, grams: g }); continue; }
      const food = per100.get(Number(e.food_id));
      if (!food) { missingFood += 1; unmatched.push({ name: ing.name, grams: g }); continue; }

      coveredGrams += g;
      for (const n of NUTRIENTS) {
        const p = food.v[n];
        // unknown is not zero. One covered ingredient with an unknown value
        // makes the whole recipe total unknown for that nutrient, because a sum
        // that silently skips it understates by an unknowable amount. This is
        // the same rule the ausnut and off loaders apply per row.
        if (p === null) { missing[n] = true; continue; }
        sums[n] += (g * p) / 100;
      }
    }

    const yieldServings = Math.max(1, Math.round(totalGrams / DIVISOR));
    const perServing = {};
    for (const n of NUTRIENTS) {
      perServing[n] = missing[n] ? null : round4(sums[n] / yieldServings);
    }

    const coverage = totalGrams > 0 ? coveredGrams / totalGrams : 0;
    if (perServing.energy_kj !== null) perServingKj.push(perServing.energy_kj);

    // Internal consistency: rebuild energy from the macros with FSANZ factors.
    // Same test catalog_audit applies to foods, so a recipe that fails it fails
    // for a reason we already know how to read. Note there is no alcohol_g
    // column, so any recipe with wine or spirits will under-predict here; that
    // is a known schema gap, not a defect in the recipe.
    let energyCheck = null;
    if (perServing.energy_kj !== null && perServing.protein_g !== null
      && perServing.fat_g !== null && perServing.carbohydrate_g !== null) {
      const predicted = perServing.protein_g * KJ_PER_G.protein
        + perServing.fat_g * KJ_PER_G.fat
        + perServing.carbohydrate_g * KJ_PER_G.carbohydrate
        + (perServing.fiber_g === null ? 0 : perServing.fiber_g * KJ_PER_G.fibre);
      energyCheck = {
        stored: round4(perServing.energy_kj),
        predicted: round4(predicted),
        diff_pct: perServing.energy_kj > 0
          ? round4(((predicted - perServing.energy_kj) / perServing.energy_kj) * 100)
          : null,
      };
    }

    out.push({
      source_record_id: r.source_record_id,
      title: r.title,
      yield_servings: yieldServings,
      servings_estimated: true,
      total_weight_g: round4(totalGrams),
      grams_per_serving: round4(totalGrams / yieldServings),
      covered_mass_fraction: round4(coverage),
      grams_low_confidence_fraction: round4(totalGrams > 0 ? lowConfGrams / totalGrams : 0),
      unmatched_ingredients: unmatched,
      nutrients_unknown: NUTRIENTS.filter((n) => missing[n]),
      carbohydrate_basis: CARB_BASIS,
      vitamin_a_convention: VIT_A,
      per_serving: perServing,
      energy_check: energyCheck,
    });
  }

  if (missingFood) {
    console.log(`WARNING: ${missingFood} ingredient references had no catalogue row`);
  }

  // ---- calibration report -------------------------------------------------
  const cov = out.map((o) => o.covered_mass_fraction);
  const full = out.filter((o) => o.covered_mass_fraction >= 0.999).length;
  console.log('');
  console.log('='.repeat(70));
  console.log('COVERAGE');
  console.log('='.repeat(70));
  console.log(`  recipes at 100% covered mass : ${full} / ${out.length}`);
  console.log(`  median covered fraction      : ${(median(cov) * 100).toFixed(2)}%`);
  console.log(`  10th percentile              : ${(pct(cov, 10) * 100).toFixed(2)}%`);

  console.log('');
  console.log('='.repeat(70));
  console.log(`YIELD CALIBRATION  (divisor ${DIVISOR} g per serving)`);
  console.log('='.repeat(70));
  console.log(`  recipes with a computed energy : ${perServingKj.length} / ${out.length}`);
  for (const p of [10, 25, 50, 75, 90]) {
    console.log(`  p${String(p).padStart(2)} per-serving kJ            : ${Math.round(pct(perServingKj, p))}`);
  }
  const band = perServingKj.filter((x) => x >= 1500 && x <= 4000).length;
  console.log(`  in the 1,500-4,000 kJ band     : ${band} / ${perServingKj.length}`
    + `  (${((band / perServingKj.length) * 100).toFixed(1)}%)`);
  const servings = out.map((o) => o.yield_servings);
  console.log(`  yield_servings median          : ${median(servings)}`
    + `   range ${Math.min(...servings)}-${Math.max(...servings)}`);

  console.log('');
  console.log('  nutrients NULL (unknown in at least one covered ingredient):');
  let anyNull = false;
  for (const n of NUTRIENTS) {
    const c = out.filter((o) => o.per_serving[n] === null).length;
    if (c) { anyNull = true; console.log(`    ${n.padEnd(24)}${String(c).padStart(4)} / ${out.length}`); }
  }
  if (!anyNull) console.log('    none');

  const offEnergy = out.filter((o) => o.energy_check && o.energy_check.diff_pct !== null
    && Math.abs(o.energy_check.diff_pct) > 20);
  console.log('');
  console.log(`  energy vs FSANZ macro reconstruction, over 20% out: ${offEnergy.length} / ${out.length}`);
  if (VERBOSE) {
    for (const o of offEnergy.slice(0, 20)) {
      console.log(`    ${String(o.energy_check.diff_pct).padStart(8)}%  ${o.title}`);
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'recipe_nutrition.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    source_name: 'themealdb',
    source_license: 'TheMealDB-ToS',
    racc_divisor_g: DIVISOR,
    carbohydrate_basis: CARB_BASIS,
    vitamin_a_convention: VIT_A,
    calculation_method: 'ingredient_calculation',
    nutrients: NUTRIENTS,
    recipes: out,
  }, null, 1));
  console.log('');
  console.log(`  wrote out/recipe_nutrition.json (${out.length} recipes)`);
} catch (err) {
  console.error('');
  console.error('COMPUTE FAILED:', err && err.message ? err.message : err);
  let c = err && err.cause;
  while (c) { console.error('  caused by:', c.code || '', c.message || c); c = c.cause; }
  process.exitCode = 1;
} finally {
  await pool.end();
}
