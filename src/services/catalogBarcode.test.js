/**
 * Barcode lookup: code normalisation, the catalogue query, the cache and the
 * probe. Runs against the live Neon database named by ENV.DB_URL (there is no
 * fixture catalogue), so it needs backend/.env and a network.
 *
 *   node --test src/services/catalogBarcode.test.js
 *
 * The OFF live fallback is NOT exercised here: it would make the suite depend
 * on a third party being up. Its mapping rules are unit-tested with fixtures in
 * offLive.test.js, and OFF_LIVE_LOOKUP=false keeps it out of the way.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.OFF_LIVE_LOOKUP = "false";

const {
  BARCODE_MIN_LENGTH,
  barcodeCandidates,
  buildBarcodeCacheKey,
  clearBarcodeLookupCache,
  hasCachedBarcodeLookup,
  lookupBarcode,
  normalizeBarcode,
  parseBarcodeParams,
} = await import("./catalogBarcode.js");

// Real rows, confirmed present 2026-09-22. If an import ever removes them the
// failure should read as "the fixture is gone", not as "lookup is broken".
const TIM_TAM = "9310072010816";     // Arnott's Tim Tam Original, 2 servings
const VEGEMITE = "9300650018860";    // Mondelez Vegemite, 2 servings
const ABSENT = "0000000000000";

const lookup = (code) => {
  const parsed = parseBarcodeParams({ code });
  assert.equal(parsed.ok, true, `parseBarcodeParams rejected ${code}: ${parsed.error}`);
  return lookupBarcode(parsed.params);
};

before(() => clearBarcodeLookupCache());

// --- parameter handling (no database) --------------------------------------

test("normalizeBarcode keeps digits only", () => {
  assert.equal(normalizeBarcode(" 931-0072 010816 "), TIM_TAM);
  assert.equal(normalizeBarcode("abc"), "");
  assert.equal(normalizeBarcode(null), "");
  assert.equal(normalizeBarcode("1".repeat(40)).length, 24);
});

test("parseBarcodeParams rejects anything too short to be a barcode", () => {
  assert.equal(parseBarcodeParams({}).ok, false);
  assert.equal(parseBarcodeParams({ code: "12345" }).ok, false);
  assert.equal(parseBarcodeParams({ code: "x".repeat(20) }).ok, false);
  assert.equal(normalizeBarcode("123456").length, BARCODE_MIN_LENGTH);
  assert.equal(parseBarcodeParams({ code: "123456" }).ok, true);
});

test("UPC-A and EAN-13 are tried as the same number", () => {
  // The 12-digit UPC-A on a pack is the EAN-13 with a leading zero.
  assert.deepEqual(barcodeCandidates("012345678905"), ["012345678905", "0012345678905"]);
  assert.deepEqual(barcodeCandidates("0012345678905"), ["0012345678905", "012345678905"]);
  // A normal AU EAN-13 has nothing to strip, so exactly one candidate.
  assert.deepEqual(barcodeCandidates(TIM_TAM), [TIM_TAM]);
});

test("the cache key is the normalised code", () => {
  const { params } = parseBarcodeParams({ code: " 9310072010816 " });
  assert.equal(buildBarcodeCacheKey(params), `catalog.barcode:${TIM_TAM}`);
});

// --- the query -------------------------------------------------------------

test("a barcode we hold returns the product with all its servings", async () => {
  const result = await lookup(TIM_TAM);
  assert.equal(result.found, true);
  assert.equal(result.source, "catalog");
  assert.equal(result.barcode, TIM_TAM);

  const { item } = result;
  assert.match(item.title, /tim tam/i);
  assert.equal(item.brand, "Arnott's");
  assert.equal(item.food_type, "branded");
  assert.equal(item.barcode, TIM_TAM);
  assert.ok(item.servings.length >= 2, `expected the pack serving and 100 g, got ${item.servings.length}`);
});

test("the default serving leads and carries the nutrition shown on the card", async () => {
  const { item } = await lookup(TIM_TAM);
  assert.equal(item.servings[0].is_default, true, "default serving must lead so the chip row opens on it");
  assert.equal(item.serving.id, item.servings[0].id);
  assert.deepEqual(item.nutrition, item.servings[0].nutrition);
  assert.equal(item.servings.filter((s) => s.is_default).length, 1);
});

test("every serving carries its own nutrition, scaled to that serving", async () => {
  const { item } = await lookup(TIM_TAM);
  const hundred = item.servings.find((s) => s.grams_equivalent === 100);
  const pack = item.servings.find((s) => s.grams_equivalent !== 100);
  assert.ok(hundred && pack, "expected a 100 g serving and a pack serving");
  // Per-serving profiles, not one profile repeated: the smaller serving must
  // carry proportionally less energy.
  const ratio = (pack.nutrition.energy_kj / hundred.nutrition.energy_kj) * 100;
  assert.ok(
    Math.abs(ratio - pack.grams_equivalent) < 0.5,
    `pack energy should scale with grams: ${ratio.toFixed(2)} vs ${pack.grams_equivalent}`,
  );
});

test("numbers come back as numbers, not strings", async () => {
  const { item } = await lookup(VEGEMITE);
  for (const key of ["energy_kj", "calories_kcal", "protein_g", "fat_g", "carbohydrate_g", "sodium_mg"]) {
    assert.equal(typeof item.nutrition[key], "number", `${key} should be a number`);
  }
  assert.equal(typeof item.serving.grams_equivalent, "number");
});

test("a barcode we do not hold is found:false, never an error", async () => {
  const result = await lookup(ABSENT);
  assert.equal(result.found, false);
  assert.equal(result.item, null);
  assert.equal(result.source, null);
  assert.equal(result.barcode, ABSENT);
});

// --- cache and probe -------------------------------------------------------

test("a repeat lookup is served from cache and the probe agrees", async () => {
  clearBarcodeLookupCache();
  const { params } = parseBarcodeParams({ code: VEGEMITE });

  assert.equal(hasCachedBarcodeLookup(params), false, "nothing cached before the first call");
  const first = await lookupBarcode(params);
  assert.equal(first.cached, false);

  assert.equal(hasCachedBarcodeLookup(params), true, "probe must see what the handler stored");
  const second = await lookupBarcode(params);
  assert.equal(second.cached, true);
  assert.equal(second.item.public_id, first.item.public_id);
});

test("a miss is cached too, so a shelf of unknown packs is not a shelf of queries", async () => {
  clearBarcodeLookupCache();
  const { params } = parseBarcodeParams({ code: ABSENT });
  await lookupBarcode(params);
  assert.equal(hasCachedBarcodeLookup(params), true);
  assert.equal((await lookupBarcode(params)).cached, true);
});

test("concurrent identical lookups share one query", async () => {
  clearBarcodeLookupCache();
  const { params } = parseBarcodeParams({ code: TIM_TAM });
  const [a, b] = await Promise.all([lookupBarcode(params), lookupBarcode(params)]);
  assert.equal(a.item.public_id, b.item.public_id);
  // One of the two rode the in-flight promise rather than issuing its own.
  assert.equal([a.cached, b.cached].filter(Boolean).length, 1);
});
