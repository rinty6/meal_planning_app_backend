/**
 * Display casing rules for OFF names and brands. Pure functions, no database.
 * The last test runs over the real off_au.json so a rule change shows its
 * blast radius in numbers.
 *
 *   node --test importers/off/displayCase.test.js
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCaseVocabulary, displayCase, hasCaseInformation, recasePayload } from './displayCase.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A vocabulary the way real data produces it: BBQ and UHT appear capitalised
// inside mixed-case names, "chicken" appears as Chicken/chicken (regular, so
// it must NOT be stored), "Lite" appears once irregularly (below the floor).
const vocab = buildCaseVocabulary([
  'Smokey BBQ Sauce', 'Sweet BBQ Chicken Wings', 'Full Cream UHT Milk', 'Skim UHT Milk',
  'Chicken Breast', 'Roast chicken', 'Chicken Wings', 'YoPRO Vanilla', 'YoPRO Perform',
  "McDonald's Cheeseburger", "McDonald's Fries", 'Australian LiTe Milk',
]);

test('mixed-case text is never touched', () => {
  for (const s of ['Egg Fried Rice', 'Egg fried rice', "Kellogg's Nutri-Grain", 'iSnack 2.0', 'Cleaver\'s ORGANIC']) {
    assert.equal(hasCaseInformation(s), true);
    assert.equal(displayCase(s, vocab), s);
  }
});

test('all-caps and all-lower names become Title Case', () => {
  assert.equal(displayCase('CHICKEN, LETTUCE & AVOCADO', vocab), 'Chicken, Lettuce & Avocado');
  assert.equal(displayCase('egg noodle', vocab), 'Egg Noodle');
  assert.equal(displayCase('THE ORIGINAL SEASHELLS', vocab), 'The Original Seashells');
});

test('small words stay lower unless they lead', () => {
  assert.equal(displayCase('FISH WITH CHIPS AND PEAS', vocab), 'Fish with Chips and Peas');
  assert.equal(displayCase('the broth sisters', vocab), 'The Broth Sisters');
});

test('apostrophes do not start a capital, hyphens and slashes do', () => {
  assert.equal(displayCase("KELLOGG'S NUTRI-GRAIN", vocab), "Kellogg's Nutri-Grain");
  assert.equal(displayCase('PASTURE-RAISED', vocab), 'Pasture-Raised');
  assert.equal(displayCase('BISKO MACA S/BREAD FINGER', vocab), 'Bisko Maca S/Bread Finger');
  assert.equal(displayCase("FISH 'N' CHIPS", vocab), "Fish 'N' Chips");
});

test('irregular vocabulary spellings win over the default', () => {
  assert.equal(displayCase('SMOKEY BBQ CHICKEN WITH UHT MILK', vocab), 'Smokey BBQ Chicken with UHT Milk');
  assert.equal(displayCase('yopro strawberry', vocab), 'YoPRO Strawberry');
  assert.equal(displayCase("MCDONALD'S BIG MAC", vocab), "McDonald's Big Mac");
});

test('regular and one-off spellings are not stored in the vocabulary', () => {
  assert.equal(vocab.has('chicken'), false, 'Chicken/chicken is regular');
  assert.equal(vocab.has('lite'), false, 'LiTe seen once is below the floor');
  assert.equal(vocab.get('bbq'), 'BBQ');
});

test('digits and units keep their letters lower-cased', () => {
  assert.equal(displayCase('ENZOS BEEF RAVIOLI RAGU 330G', vocab), 'Enzos Beef Ravioli Ragu 330g');
  assert.equal(displayCase('MULTIGRAIN ROLLS 6PK', vocab), 'Multigrain Rolls 6pk');
  assert.equal(displayCase('12345', vocab), '12345');
});

test('brand guard keeps a short all-caps LEADING word only', () => {
  const brand = { brand: true };
  assert.equal(displayCase('IGA', vocab, brand), 'IGA');
  assert.equal(displayCase('SPC ARDMONA', vocab, brand), 'SPC Ardmona');
  assert.equal(displayCase('28GO', vocab, brand), '28GO');
  assert.equal(displayCase('SUPERPOP PTY LTD', vocab, brand), 'Superpop Pty Ltd');
  assert.equal(displayCase('GRAZE', vocab, brand), 'Graze');
  assert.equal(displayCase('coles', vocab, brand), 'Coles');
  // Food names get no guard: a lone short all-caps food name still title-cases.
  assert.equal(displayCase('UFC', vocab), 'Ufc');
});

test('only case changes: lower-casing the result gives back the input', () => {
  for (const s of ['CHICKEN, LETTUCE & AVOCADO', "KELLOGG'S NUTRI-GRAIN", 'egg noodle', '10 Y. O. WHISKY 46%']) {
    assert.equal(displayCase(s, vocab).toLowerCase(), s.toLowerCase());
  }
});

test('recasePayload over the real extract touches only rows without case information', () => {
  const payload = JSON.parse(
    readFileSync(path.resolve(HERE, '../../../tools/off_extract/out/off_au.json'), 'utf-8'),
  );
  const { foods, brands } = recasePayload(payload);
  let changedFoods = 0;
  foods.forEach((f, i) => {
    const raw = payload.foods[i].name;
    if (f.name !== raw) {
      changedFoods += 1;
      assert.equal(hasCaseInformation(raw), false, `touched a mixed-case name: ${raw}`);
      assert.equal(f.name.toLowerCase(), raw.toLowerCase(), `changed letters in: ${raw}`);
    }
    assert.equal(f.normalized_name, raw.toLowerCase(), 'normalized_name untouched');
  });
  const changedBrands = brands.filter((b, i) => b.name !== payload.brands[i].name).length;
  // Measured 2026-09-21: 2,517 foods (5.5%) and 410 brands. A rule change that
  // moves these by more than a few hundred deserves a look before it ships.
  assert.ok(changedFoods > 2000 && changedFoods < 3200, `foods changed: ${changedFoods}`);
  assert.ok(changedBrands > 250 && changedBrands < 600, `brands changed: ${changedBrands}`);
});
