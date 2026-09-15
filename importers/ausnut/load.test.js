/**
 * Checks the loader's scaling math against ausnut.json WITHOUT a database.
 * The scale factor is the single most likely importer bug (checklist p2-13's
 * warning applies here too): it is invisible at a 100 g serving and wrong
 * everywhere else, so a 100 g-only test would pass while every can of beer is
 * silently a third of its true energy.
 *
 *   node --test importers/ausnut/load.test.js
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { profileFor, servingsFor } from './load.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const payload = JSON.parse(
  readFileSync(path.resolve(HERE, '../../../tools/ausnut_extract/out/ausnut.json'), 'utf-8'),
);
const meta = {
  source_name: payload.source_name,
  source_license: payload.source_license,
  basis_state: payload.basis_state,
  carbohydrate_basis: payload.carbohydrate_basis,
  vitamin_a_convention: payload.vitamin_a_convention,
};
const byId = new Map(payload.foods.map((f) => [f.source_record_id, f]));

test('a 100 g serving is unscaled', () => {
  const food = byId.get('29101002');
  const p = profileFor(food, { grams_equivalent: 100 }, meta);
  assert.equal(p.energyKj, food.nutrients.energy_kj);
  assert.equal(p.basisQuantity, 100);
  assert.equal(p.basisUnit, 'g');
});

test('a real serving scales by grams/100', () => {
  const food = byId.get('29101002');            // beer, 152 kJ per 100 g
  const can = food.servings.find((s) => s.description === '1 can (330 ml)');
  assert.ok(can, 'the 330 ml can should exist');
  const p = profileFor(food, can, meta);
  // 331.65 g of a 152 kJ/100 g food = 504.108 kJ
  assert.equal(p.basisQuantity, 331.65);
  assert.ok(Math.abs(p.energyKj - 152 * 3.3165) < 0.01, `got ${p.energyKj}`);
  assert.ok(p.energyKj > food.nutrients.energy_kj, 'a 331 g serving must exceed the 100 g figure');
});

test('absent nutrients stay null and never become zero', () => {
  const food = { nutrients: { energy_kj: 100 }, source_derivation: 'analysed' };
  const p = profileFor(food, { grams_equivalent: 100 }, meta);
  assert.equal(p.energyKj, 100);
  assert.equal(p.proteinG, null);
  assert.notEqual(p.proteinG, 0);
});

test('source metadata travels onto every profile', () => {
  const p = profileFor(byId.get('29101002'), { grams_equivalent: 100 }, meta);
  assert.equal(p.basisState, 'edible_portion');
  assert.equal(p.carbohydrateBasis, 'available');
  assert.equal(p.vitaminAConvention, 're');
  assert.equal(p.sourceDerivation, 'analysed');
  assert.equal(p.calculationMethod, 'scaled_from_per_100g');
});

test('exactly one serving per food is the default', () => {
  for (const food of payload.foods) {
    const defaults = servingsFor(food).filter((s) => s.isDefault);
    assert.equal(defaults.length, 1, `${food.source_record_id} has ${defaults.length} defaults`);
  }
});

test('a food with no measures gets one synthesised 100 g serving', () => {
  const bare = payload.foods.find((f) => f.servings.length === 0);
  assert.ok(bare, 'the export should contain foods with no measures');
  const servings = servingsFor(bare);
  assert.equal(servings.length, 1);
  assert.equal(servings[0].grams_equivalent, 100);
  // A sentinel, not NULL: NULLs are distinct in Postgres, so a NULL here would
  // insert a duplicate serving on every re-run instead of matching.
  assert.equal(servings[0].source_record_id, 'synthetic:100g');
});

test('every serving carries a source_record_id for idempotent upserts', () => {
  for (const food of payload.foods) {
    for (const s of servingsFor(food)) {
      assert.ok(s.source_record_id, `${food.source_record_id} has a serving with no id`);
    }
  }
});

test('no scaled value overflows numeric(12,4)', () => {
  const limit = 99999999.9999;
  for (const food of payload.foods) {
    for (const s of servingsFor(food)) {
      for (const [k, v] of Object.entries(profileFor(food, s, meta))) {
        if (typeof v === 'number') {
          assert.ok(v <= limit, `${food.source_record_id}.${k} = ${v} overflows`);
          assert.ok(v >= 0, `${food.source_record_id}.${k} = ${v} is negative`);
        }
      }
    }
  }
});
