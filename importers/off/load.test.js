/**
 * Checks the OFF loader's scaling and row shaping against off_au.json WITHOUT a
 * database. The scale factor is invisible at a 100 g serving and wrong
 * everywhere else, so the label-serving cases are what actually matter here.
 *
 *   node --test importers/off/load.test.js
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { foodRow, profileFor, servingRow } from './load.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(
  readFileSync(path.resolve(HERE, '../../../tools/off_extract/out/off_au.json'), 'utf-8'),
);
const meta = {
  source_name: payload.source_name,
  source_license: payload.source_license,
  basis_state: payload.basis_state,
  carbohydrate_basis: payload.carbohydrate_basis,
  vitamin_a_convention: payload.vitamin_a_convention,
};
const withLabelServing = payload.foods.find((f) => f.servings.length > 1);

test('the 100 g serving is unscaled', () => {
  const food = payload.foods[0];
  const p = profileFor(food, { grams_equivalent: 100 }, meta);
  assert.equal(p.energyKj, food.nutrients.energy_kj);
  assert.equal(p.basisQuantity, 100);
  assert.equal(p.basisUnit, 'g');
});

test('a label serving scales by grams/100', () => {
  const food = withLabelServing;
  const label = food.servings.find((s) => s.source_record_id === 'label:serving');
  const grams = label.grams_equivalent;
  assert.notEqual(grams, 100, 'fixture must not be a 100 g serving or it proves nothing');
  const p = profileFor(food, label, meta);
  assert.equal(p.basisQuantity, grams);
  const expected = food.nutrients.energy_kj * (grams / 100);
  assert.ok(Math.abs(p.energyKj - expected) < 0.01, `${p.energyKj} vs ${expected}`);
  // Direction check: a sub-100 g serving must be smaller, not larger.
  if (grams < 100) assert.ok(p.energyKj < food.nutrients.energy_kj);
  else assert.ok(p.energyKj > food.nutrients.energy_kj);
});

test('mg and mcg columns scale with the serving too', () => {
  const food = payload.foods.find((f) => f.nutrients.sodium_mg > 0 && f.servings.length > 1);
  const label = food.servings.find((s) => s.source_record_id === 'label:serving');
  const p = profileFor(food, label, meta);
  const expected = food.nutrients.sodium_mg * (label.grams_equivalent / 100);
  assert.ok(Math.abs(p.sodiumMg - expected) < 0.01, `${p.sodiumMg} vs ${expected}`);
});

test('absent nutrients stay null and never become zero', () => {
  const food = { nutrients: { energy_kj: 100 } };
  const p = profileFor(food, { grams_equivalent: 100 }, meta);
  assert.equal(p.energyKj, 100);
  assert.equal(p.proteinG, null);
  assert.notEqual(p.proteinG, 0);
});

test('OFF provenance is written onto every profile', () => {
  const p = profileFor(payload.foods[0], { grams_equivalent: 100 }, meta);
  assert.equal(p.basisState, 'as_sold');            // not AUSNUT's edible_portion
  assert.equal(p.carbohydrateBasis, 'available');
  assert.equal(p.vitaminAConvention, null);         // OFF states neither RE nor RAE
  assert.equal(p.sourceDerivation, 'label_data');
  assert.equal(p.sourceLicense, 'ODbL-1.0');
});

test('every food carries a barcode and a typed public id', () => {
  for (const food of payload.foods) {
    const row = foodRow(food, meta, null);
    assert.ok(row.barcode, `${food.source_record_id} has no barcode`);
    assert.equal(row.barcode, row.sourceRecordId);
    assert.ok(row.publicId.startsWith('food_'), row.publicId);
    assert.equal(row.foodType, 'branded');
    assert.equal(row.region, 'AU');
  }
});

test('exactly one serving per product is the default', () => {
  for (const food of payload.foods) {
    const defaults = food.servings.filter((s) => s.is_default);
    assert.equal(defaults.length, 1, `${food.source_record_id} has ${defaults.length}`);
  }
});

test('every serving carries a sentinel id for idempotent upserts', () => {
  const allowed = new Set(['synthetic:100g', 'label:serving']);
  for (const food of payload.foods) {
    for (const s of food.servings) {
      assert.ok(allowed.has(s.source_record_id), `${food.source_record_id}: ${s.source_record_id}`);
    }
    // Both sentinels are unique per food, which is what the composite unique
    // index relies on.
    const ids = food.servings.map((s) => s.source_record_id);
    assert.equal(new Set(ids).size, ids.length, `${food.source_record_id} repeats a sentinel`);
  }
});

test('serving rows fit the metric_unit CHECK', () => {
  const row = servingRow(1, 1, withLabelServing.servings[0], 0);
  assert.ok(['g', 'ml', 'oz'].includes(row.metricUnit));
});

test('no scaled value overflows numeric(12,4)', () => {
  const limit = 99999999.9999;
  for (const food of payload.foods) {
    for (const s of food.servings) {
      for (const [k, v] of Object.entries(profileFor(food, s, meta))) {
        if (typeof v === 'number') {
          assert.ok(v <= limit && v >= 0, `${food.source_record_id}.${k} = ${v}`);
        }
      }
    }
  }
});
