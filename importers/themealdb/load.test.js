/**
 * Checks the recipe loader's row building against the real stage-1/2 JSON,
 * WITHOUT a database.
 *
 * The scale trap here is different from the AUSNUT loader's but just as easy to
 * get wrong. AUSNUT's risk was multiplying per-100 g values by a serving size.
 * This loader multiplies nothing: compute.js already produced PER-SERVING
 * figures, and the row it writes must declare basis_quantity = grams per
 * serving. If someone later "tidies" that to 100, every recipe silently becomes
 * a per-100 g row holding per-serving numbers, which for a 300 g serving is a
 * 3x error that no CHECK constraint would catch. Test 2 is that guard.
 *
 *   node --test importers/themealdb/load.test.js
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProfileRow, buildRecipeRow, buildIngredientRows, buildStepRows,
  publicIdFor, NUTRIENTS, SOURCE_NAME, SOURCE_LICENSE,
} from './load.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(path.resolve(HERE, p), 'utf-8'));

const payload = read('../../../tools/themealdb_extract/out/themealdb.json');
const nutrition = read('out/recipe_nutrition.json');
const imap = read('out/ingredient_map.json').map;

const byId = new Map(nutrition.recipes.map((n) => [n.source_record_id, n]));
const recipeFor = (id) => payload.recipes.find((r) => r.source_record_id === id);

// Schema CHECKs we are asserting against, copied from food_schema.js so a
// change there shows up here as a failing test rather than a failing INSERT.
const ALLOWED_BASIS_STATE = ['as_sold', 'edible_portion', 'prepared'];
const ALLOWED_CALC_METHOD = ['lab', 'label', 'ingredient_calculation', 'manual', 'scaled_from_per_100g'];
const ALLOWED_DERIVATION = ['analysed', 'label_data', 'recipe', 'borrowed', 'imputed', 'estimated', 'unknown'];
const NUMERIC_12_4_MAX = 10 ** 8; // numeric(12,4) holds 8 integer digits

test('every computed recipe has a source recipe, and counts line up', () => {
  assert.equal(nutrition.recipes.length, payload.recipes.length);
  for (const n of nutrition.recipes) {
    assert.ok(recipeFor(n.source_record_id), `no source recipe for ${n.source_record_id}`);
  }
});

test('public_id satisfies the catalog_recipes CHECK', () => {
  for (const n of nutrition.recipes.slice(0, 50)) {
    const id = publicIdFor(n.source_record_id);
    assert.match(id, /^recipe_/, `${id} must start with recipe_`);
    assert.ok(!/\s/.test(id), `${id} must not contain whitespace`);
  }
  assert.equal(publicIdFor('52764'), 'recipe_themealdb_52764');
});

test('basis_quantity is GRAMS PER SERVING, never 100', () => {
  // Pick a recipe whose serving is clearly not 100 g, so the assertion cannot
  // pass by coincidence the way a 100 g-only fixture would let it.
  const n = nutrition.recipes.find((x) => x.grams_per_serving > 150);
  assert.ok(n, 'expected at least one recipe with a serving over 150 g');
  const p = buildProfileRow(n);
  assert.equal(p.basis_quantity, n.grams_per_serving);
  assert.notEqual(p.basis_quantity, 100);
  assert.equal(p.basis_unit, 'g');
});

test('per-serving x yield reconstructs a sane whole-recipe total', () => {
  const n = nutrition.recipes.find((x) => x.per_serving.energy_kj > 0 && x.yield_servings > 1);
  const p = buildProfileRow(n);
  const wholeKj = p.energy_kj * n.yield_servings;
  assert.ok(wholeKj > p.energy_kj, 'whole recipe must exceed one serving');
  // Mass must reconcile the same way, which is what catches a yield that was
  // computed from one number and a serving size from another.
  const massBack = n.grams_per_serving * n.yield_servings;
  assert.ok(Math.abs(massBack - n.total_weight_g) < 1,
    `mass round-trip off: ${massBack} vs ${n.total_weight_g}`);
});

test('unknown nutrients stay null and never become zero', () => {
  const n = nutrition.recipes.find((x) => x.nutrients_unknown.length > 0);
  if (!n) {
    // Currently true of this dataset: AUSNUT carries all 20 fields for every
    // food, so nothing is unknown. Assert that rather than skipping silently,
    // so the day a source with gaps is added, this test starts doing work.
    assert.ok(nutrition.recipes.every((x) => x.nutrients_unknown.length === 0));
    return;
  }
  const p = buildProfileRow(n);
  for (const k of n.nutrients_unknown) {
    assert.equal(p[k], null, `${k} must be null, not ${p[k]}`);
    assert.notEqual(p[k], 0);
  }
});

test('profile carries the conventions and passes every enum CHECK', () => {
  const p = buildProfileRow(nutrition.recipes[0]);
  assert.ok(ALLOWED_BASIS_STATE.includes(p.basis_state));
  assert.ok(ALLOWED_CALC_METHOD.includes(p.calculation_method));
  assert.ok(ALLOWED_DERIVATION.includes(p.source_derivation));
  assert.equal(p.calculation_method, 'ingredient_calculation');
  assert.equal(p.source_derivation, 'recipe');
  assert.ok(['by_difference', 'available'].includes(p.carbohydrate_basis));
  assert.ok(p.vitamin_a_convention === null || ['rae', 're'].includes(p.vitamin_a_convention));
  assert.equal(p.source_name, SOURCE_NAME);
  assert.equal(p.source_license, SOURCE_LICENSE);
});

test('confidence carries covered mass and stays inside 0..1', () => {
  for (const n of nutrition.recipes) {
    const p = buildProfileRow(n);
    assert.equal(p.confidence, n.covered_mass_fraction);
    assert.ok(p.confidence >= 0 && p.confidence <= 1, `confidence ${p.confidence} out of range`);
  }
});

test('no value overflows numeric(12,4)', () => {
  for (const n of nutrition.recipes) {
    const p = buildProfileRow(n);
    assert.ok(p.basis_quantity < NUMERIC_12_4_MAX, `basis_quantity ${p.basis_quantity}`);
    for (const k of NUTRIENTS) {
      if (p[k] === null) continue;
      assert.ok(Math.abs(p[k]) < NUMERIC_12_4_MAX, `${k} = ${p[k]} on ${n.title}`);
      assert.ok(p[k] >= 0, `${k} is negative (${p[k]}) on ${n.title}`);
    }
  }
});

test('recipe row is per_serving, estimated, and stores no fake zero times', () => {
  const n = nutrition.recipes[0];
  const rec = buildRecipeRow(recipeFor(n.source_record_id), n, 999);
  assert.equal(rec.nutrition_basis, 'per_serving');
  assert.equal(rec.servings_estimated, true);
  assert.ok(rec.yield_servings > 0, 'CHECK requires yield_servings > 0');
  assert.equal(rec.prep_time_min, null);
  assert.equal(rec.cook_time_min, null);
  assert.notEqual(rec.prep_time_min, 0);
  assert.equal(rec.nutrition_profile_id, 999);
  assert.equal(rec.verification_status, 'unverified');
});

test('food_id is set only for high|medium matches', () => {
  let checkedNull = 0;
  let checkedSet = 0;
  for (const r of payload.recipes) {
    const rows = buildIngredientRows(r, imap, 1);
    rows.forEach((row, i) => {
      const e = imap[r.ingredients[i].name.trim().toLowerCase()];
      const usable = e && (e.confidence === 'high' || e.confidence === 'medium');
      if (usable) {
        assert.equal(row.food_id, Number(e.food_id));
        checkedSet += 1;
      } else {
        assert.equal(row.food_id, null);
        checkedNull += 1;
      }
    });
  }
  assert.ok(checkedSet > 4000, `expected most ingredients mapped, got ${checkedSet}`);
  assert.ok(checkedNull > 0, 'expected some unmapped ingredients to exist');
});

test('ingredient rows satisfy NOT NULL and the serving-requires-food CHECK', () => {
  for (const r of payload.recipes) {
    for (const row of buildIngredientRows(r, imap, 1)) {
      assert.ok(typeof row.display_text === 'string' && row.display_text.length > 0,
        `display_text is NOT NULL on ${r.title}`);
      assert.ok(Number.isFinite(row.quantity), 'quantity is NOT NULL');
      assert.ok(Number.isInteger(row.position) && row.position > 0);
      // food_serving_id IS NULL OR food_id IS NOT NULL
      assert.equal(row.food_serving_id, null);
    }
  }
});

test('ingredient positions are unique within a recipe', () => {
  for (const r of payload.recipes) {
    const seen = new Set();
    for (const row of buildIngredientRows(r, imap, 1)) {
      assert.ok(!seen.has(row.position), `duplicate position ${row.position} in ${r.title}`);
      seen.add(row.position);
    }
  }
});

test('step numbers start at 1 and are contiguous', () => {
  let total = 0;
  for (const r of payload.recipes) {
    const rows = buildStepRows(r, 1);
    rows.forEach((row, i) => {
      assert.equal(row.step_number, i + 1);
      assert.ok(row.step_number > 0, 'CHECK requires step_number > 0');
      assert.ok(row.instruction.length > 0, 'instruction is NOT NULL');
    });
    total += rows.length;
  }
  assert.equal(total, 2544, `expected 2,544 steps across the corpus, got ${total}`);
});
