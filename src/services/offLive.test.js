/**
 * The Open Food Facts live mapping. Fixtures only, no network and no database:
 * these rules must hold whether or not OFF is up, and they are the rules that
 * decide what numbers reach someone's meal log.
 *
 *   node --test src/services/offLive.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchOffProduct,
  firstBrand,
  mapOffNutrients,
  mapOffProduct,
  mapOffServings,
  scaleNutrition,
} from "./offLive.js";

/** A complete, plausible AU panel per 100 g. */
const panel = (overrides = {}) => ({
  "energy-kj_100g": 2192,
  "energy-kcal_100g": 524,
  proteins_100g: 5.1,
  carbohydrates_100g: 65.6,
  fat_100g: 26.4,
  "saturated-fat_100g": 15.2,
  sodium_100g: 0.168,   // GRAMS on the wire; 168 mg on the plate
  sugars_100g: 44.5,
  ...overrides,
});

const product = (overrides = {}) => ({
  product_name: "Tim Tam Original",
  brands: "Arnott's, Campbell Arnott's",
  serving_quantity: "18.3",
  serving_size: "1 biscuit (18.3 g)",
  nutriments: panel(),
  ...overrides,
});

const payload = (p = product()) => ({ status: 1, product: p });

// --- the unit trap ---------------------------------------------------------

test("mg and mcg columns are scaled out of grams", () => {
  const n = mapOffNutrients(product({ nutriments: panel({ sodium_100g: 0.4, calcium_100g: 0.107 }) }));
  assert.equal(n.sodium_mg, 400, "0.4 g of sodium is 400 mg, not 0.4");
  assert.equal(n.calcium_mg, 107);
  assert.equal(n.protein_g, 5.1, "gram columns are not scaled");
});

test("only the _100g fields are read, never the label value", () => {
  const n = mapOffNutrients(product({
    nutriments: panel({ proteins_value: 0.9, proteins_serving: 0.9, proteins_100g: 5.1 }),
  }));
  assert.equal(n.protein_g, 5.1);
});

// --- impossible values -----------------------------------------------------

test("an impossible required value rejects the product rather than half-filling it", () => {
  assert.equal(mapOffNutrients(product({ nutriments: panel({ carbohydrates_100g: 210 }) })), null);
  assert.equal(mapOffNutrients(product({ nutriments: panel({ proteins_100g: -3 }) })), null);
});

test("an impossible optional value is dropped, the product survives", () => {
  const n = mapOffNutrients(product({ nutriments: panel({ "vitamin-d_100g": 0.5 }) })); // 500,000 mcg
  assert.ok(n, "the panel is still complete");
  assert.equal(n.vitamin_d_mcg, undefined);
});

test("an incomplete panel is rejected", () => {
  const short = panel();
  delete short.sugars_100g;
  assert.equal(mapOffNutrients(product({ nutriments: short })), null);
});

// --- energy ----------------------------------------------------------------

test("the energy pair is reconciled at 4.184 with kJ surviving", () => {
  const n = mapOffNutrients(product({ nutriments: panel({ "energy-kj_100g": 2192, "energy-kcal_100g": 999 }) }));
  assert.equal(n.energy_kj, 2192);
  assert.equal(n.calories_kcal, Math.round((2192 / 4.184) * 10000) / 10000);
});

test("kJ is derived when only kcal is published", () => {
  const only = panel();
  delete only["energy-kj_100g"];
  const n = mapOffNutrients(product({ nutriments: only }));
  assert.equal(n.energy_kj, Math.round(524 * 4.184 * 10000) / 10000);
});

test("no usable energy at all is a rejection", () => {
  const none = panel();
  delete none["energy-kj_100g"];
  delete none["energy-kcal_100g"];
  assert.equal(mapOffNutrients(product({ nutriments: none })), null);
});

// --- servings --------------------------------------------------------------

test("every product gets a 100 g serving, and the label serving becomes the default", () => {
  const servings = mapOffServings(product());
  assert.equal(servings.length, 2);
  assert.equal(servings[0].description, "100 g");
  assert.equal(servings[0].is_default, false);
  assert.equal(servings[1].description, "1 biscuit (18.3 g)");
  assert.equal(servings[1].is_default, true);
  assert.equal(servings[1].grams_equivalent, 18.3);
});

test("a 100 g label serving is not duplicated", () => {
  const servings = mapOffServings(product({ serving_quantity: "100", serving_size: "1 portion (100 g)" }));
  assert.equal(servings.length, 1);
  assert.equal(servings[0].is_default, true);
});

test("a serving label with no number at all gets the grams appended", () => {
  const servings = mapOffServings(product({ serving_quantity: "30", serving_size: "handful" }));
  assert.equal(servings[1].description, "handful (30 g)");
});

test("a label that already names a number is trusted as written", () => {
  // Same rule as tools/off_extract/extract.py: "1 portion (25 g)" must not
  // become "1 portion (25 g) (25 g)". The cost is that a count without a mass,
  // "1 handful", keeps no grams in its text; the grams are on the serving row.
  const servings = mapOffServings(product({ serving_quantity: "30", serving_size: "1 handful" }));
  assert.equal(servings[1].description, "1 handful");
  assert.equal(servings[1].grams_equivalent, 30);
});

test("a serving with no usable label falls back to the grams", () => {
  const servings = mapOffServings(product({ serving_quantity: "30", serving_size: null }));
  assert.equal(servings[1].description, "30 g");
});

test("a nonsense serving quantity is ignored", () => {
  for (const q of ["0", "-5", "99999", "", null]) {
    assert.equal(mapOffServings(product({ serving_quantity: q })).length, 1, `serving_quantity ${q}`);
  }
});

test("nutrition is scaled to each serving", () => {
  const scaled = scaleNutrition({ energy_kj: 2192, protein_g: 5.1, sodium_mg: null }, 18.3);
  assert.equal(scaled.energy_kj, Math.round(2192 * 0.183 * 10000) / 10000);
  assert.equal(scaled.protein_g, Math.round(5.1 * 0.183 * 10000) / 10000);
  assert.equal(scaled.sodium_mg, null, "an absent nutrient stays absent, never becomes 0");
});

// --- the whole product -----------------------------------------------------

test("a good product maps to the same shape a catalogue hit has", () => {
  const item = mapOffProduct(payload(), "9310072010816");
  assert.equal(item.public_id, "food_off_9310072010816");
  assert.equal(item.title, "Tim Tam Original");
  assert.equal(item.brand, "Arnott's", "multi-brand text keeps the first name only");
  assert.equal(item.food_type, "branded");
  assert.equal(item.source_name, "openfoodfacts_live");
  assert.equal(item.verification_status, "unverified");
  assert.equal(item.barcode, "9310072010816");
  assert.equal(item.serving.description, "1 biscuit (18.3 g)");
  assert.deepEqual(item.nutrition, item.serving.nutrition);
  assert.equal(item.servings.length, 2);
  assert.equal(typeof item.nutrition.energy_kj, "number");
});

test("a product carrying any data-quality error tag is rejected", () => {
  const flagged = payload(product({
    data_quality_errors_tags: ["en:nutrition-data-per-serving-missing-serving-size"],
  }));
  assert.equal(mapOffProduct(flagged, "3017620422003"), null);
});

test("no product, no name, or status 0 all map to null", () => {
  assert.equal(mapOffProduct({ status: 0 }, "1"), null);
  assert.equal(mapOffProduct({ status: 1 }, "1"), null);
  assert.equal(mapOffProduct(payload(product({ product_name: "  " })), "1"), null);
  assert.equal(mapOffProduct(null, "1"), null);
});

test("firstBrand handles the free-text field", () => {
  assert.equal(firstBrand("Arnott's, Campbell"), "Arnott's");
  assert.equal(firstBrand("  "), null);
  assert.equal(firstBrand(null), null);
  assert.equal(firstBrand("x".repeat(200)), null);
});

// --- the fetch wrapper -----------------------------------------------------

test("fetchOffProduct never throws: a timeout, a 500 and bad JSON are all no answer", async () => {
  const cases = [
    () => Promise.reject(new Error("network down")),
    () => Promise.resolve({ ok: false, status: 500 }),
    () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error("not json")) }),
  ];
  for (const fetchImpl of cases) {
    assert.equal(await fetchOffProduct("9310072010816", { fetchImpl }), null);
  }
});

test("fetchOffProduct maps a good response and identifies the client", async () => {
  let seenUrl = null;
  let seenHeaders = null;
  const item = await fetchOffProduct("9310072010816", {
    fetchImpl: (url, options) => {
      seenUrl = url;
      seenHeaders = options.headers;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload()) });
    },
  });
  assert.equal(item.title, "Tim Tam Original");
  assert.match(seenUrl, /\/api\/v2\/product\/9310072010816\.json$/);
  assert.match(seenHeaders["User-Agent"], /GoodHealthMate/, "OFF throttles anonymous clients");
});
