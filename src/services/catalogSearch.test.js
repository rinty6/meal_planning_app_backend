// Catalogue search: ranking, filters, facets, cache. Runs against the live
// Neon database named by ENV.DB_URL (there is no fixture catalogue), so it
// needs backend/.env and a network. Run: node --test src/services/catalogSearch.test.js
//
// The 22 probes are the 2026-09-05 experiment set (claude_memory/database
// redesign/test results/scripts/search_ranking.js). `base` asserts the top
// hit's base_name, which is the grouping key, so the test does not over-specify
// WHICH banana wins; `has` is for branded rows where base_name is the whole name.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCacheKey,
  clearCatalogSearchCache,
  hasCachedCatalogSearch,
  normalizeQuery,
  parseSearchParams,
  searchCatalogFoods,
} from "./catalogSearch.js";

const search = (input) => {
  const parsed = parseSearchParams(input);
  assert.equal(parsed.ok, true, `parseSearchParams rejected ${JSON.stringify(input)}: ${parsed.error}`);
  return searchCatalogFoods(parsed.params);
};

// --- parameter handling (no database) -------------------------------------

test("parseSearchParams normalises and clamps", () => {
  assert.equal(parseSearchParams({}).ok, false);
  assert.equal(parseSearchParams({ q: "   " }).ok, false);
  const { params } = parseSearchParams({
    q: "  Tim-Tam!!  ", segment: ["Lean", "raw", "lean"], source: "GENERIC", limit: "999", offset: "-4",
  });
  assert.deepEqual(params, { query: "tim-tam", segments: ["lean", "raw"], source: "generic", limit: 50, offset: 0 });
  assert.equal(parseSearchParams({ q: "x", source: "weird" }).params.source, null);
  assert.equal(normalizeQuery("a".repeat(200)).length, 80);
});

test("cache key is stable across segment order", () => {
  const a = parseSearchParams({ q: "beer", segment: ["b", "a"] }).params;
  const b = parseSearchParams({ q: "beer", segment: ["a", "b"] }).params;
  assert.equal(buildCacheKey(a), buildCacheKey(b));
});

// --- ranking (database) ----------------------------------------------------

const PROBES = [
  { q: "salt", base: "salt" }, { q: "butter", base: "butter" }, { q: "egg", base: "egg" },
  { q: "banana", base: "banana" }, { q: "milk", base: "milk" }, { q: "bread", base: "bread" },
  { q: "rice", base: "rice" }, { q: "chicken", base: "chicken" }, { q: "cheese", base: "cheese" },
  { q: "apple", base: "apple" }, { q: "potato", base: "potato" }, { q: "yoghurt", base: "yoghurt" },
  { q: "olive oil", base: "oil" }, { q: "white bread", base: "bread" }, { q: "rolled oats", base: "oats" },
  { q: "tomato sauce", base: "sauce" }, { q: "peanut butter", base: "peanut butter" },
  { q: "baked beans", base: "baked beans" },
  { q: "weet-bix", has: "weet" }, { q: "vegemite", has: "vegemite" }, { q: "tim tam", has: "tim tam" },
  { q: "nutella", has: "nutella" },
];

test("the 22 probes return the expected food at rank 1", async () => {
  clearCatalogSearchCache();
  const failures = [];
  for (const probe of PROBES) {
    const { items } = await search({ q: probe.q, limit: 1 });
    const top = items[0];
    const ok = probe.base
      ? top?.base_name === probe.base
      : String(top?.title ?? "").toLowerCase().includes(probe.has);
    if (!ok) failures.push(`${probe.q} -> ${top?.title ?? "(none)"}`);
  }
  assert.deepEqual(failures, [], `probes failing at rank 1:\n${failures.join("\n")}`);
});

test("within a base_name group, household servings rank above bare 100 g rows (p1-02)", async () => {
  const { items } = await search({ q: "chicken", limit: 6 });
  const titles = items.map((i) => i.title);
  for (const cut of ["breast", "thigh", "wing", "drumstick"]) {
    assert.ok(titles.some((t) => t.includes(`, ${cut},`)), `expected a chicken ${cut} in the first 6, got:\n${titles.join("\n")}`);
  }
  assert.ok(!titles.some((t) => /^Chicken, (skin|liver|separable fat),/.test(t)), `skin/liver/fat should not lead:\n${titles.join("\n")}`);
  for (const item of items) assert.doesNotMatch(item.serving.description, /^\s*100\s*(g|ml)\s*$/i);
});

test("every hit carries a default serving and its nutrition profile with numbers, not strings", async () => {
  const { items } = await search({ q: "beer", limit: 5 });
  assert.ok(items.length >= 5);
  for (const item of items) {
    assert.match(item.public_id, /^food_/);
    assert.equal(typeof item.serving.id, "number");
    assert.ok(item.serving.description.length > 0);
    assert.equal(typeof item.nutrition.energy_kj, "number");
    assert.equal(typeof item.nutrition.calories_kcal, "number");
    assert.ok(Array.isArray(item.name_segments));
    assert.ok("vitamin_a_convention" in item.nutrition, "vitamin A must travel with its convention");
  }
});

// --- filters and facets ----------------------------------------------------

test("segment filter matches on the label and ANDs across chips", async () => {
  const full = await search({ q: "beer", segment: "full strength" });
  assert.ok(full.items.length >= 3);
  for (const item of full.items) {
    assert.ok(item.name_segments.some((s) => s.startsWith("full strength")), item.title);
  }
  const both = await search({ q: "beer", segment: ["full strength", "gluten free"] });
  assert.equal(both.items.length, 1);
  assert.match(both.items[0].title, /gluten free/);
});

test("source filter separates generic from branded", async () => {
  const generic = await search({ q: "beer", source: "generic", limit: 20 });
  assert.ok(generic.items.length > 0);
  assert.ok(generic.items.every((i) => i.food_type === "generic" && i.brand === null));
  const branded = await search({ q: "beer", source: "branded", limit: 20 });
  assert.ok(branded.items.length > 0);
  assert.ok(branded.items.every((i) => i.food_type !== "generic"));
});

test("facets come from relevant rows, grouped by label, excluding the query word", async () => {
  const { facets, meta } = await search({ q: "beer", limit: 8 });
  const labels = facets.segments.map((f) => f.label);
  assert.ok(labels.includes("full strength"), labels.join(", "));
  assert.ok(!labels.includes("beer"));
  assert.ok(!labels.some((l) => /\(.*\)$/.test(l)), `labels must have the (…) qualifier stripped: ${labels.join(", ")}`);
  assert.ok(!labels.includes("steak"), "a beer search must not offer beef facets");
  assert.ok(labels.length <= 8);
  assert.ok(facets.sources.generic > 0 && facets.sources.branded > 0);
  assert.ok(meta.total_relevant > 0 && meta.total_relevant <= meta.total_candidates);
  for (const f of facets.segments) assert.equal(f.value, f.label);
});

test("chained facets narrow further", async () => {
  const { items, facets } = await search({ q: "chicken", segment: ["lean", "raw"], limit: 20 });
  assert.ok(items.length >= 4 && items.length <= 20);
  const labels = facets.segments.map((f) => f.label);
  assert.ok(labels.includes("breast") || labels.includes("thigh"), labels.join(", "));
});

test("a nonsense query is a 200-shaped empty result, not an error", async () => {
  const result = await search({ q: "zzqx" });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.facets.segments, []);
  assert.equal(result.meta.total_candidates, 0);
});

// --- cache -----------------------------------------------------------------

test("repeat search is served from cache and the probe agrees", async () => {
  clearCatalogSearchCache();
  const { params } = parseSearchParams({ q: "olive oil", limit: 3 });
  assert.equal(hasCachedCatalogSearch(params), false);
  const first = await searchCatalogFoods(params);
  assert.equal(first.cached, false);
  assert.equal(hasCachedCatalogSearch(params), true);
  const second = await searchCatalogFoods(params);
  assert.equal(second.cached, true);
  assert.deepEqual(second.items, first.items);
});

test("concurrent identical searches share one query", async () => {
  clearCatalogSearchCache();
  const { params } = parseSearchParams({ q: "banana", limit: 3 });
  const [a, b] = await Promise.all([searchCatalogFoods(params), searchCatalogFoods(params)]);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true, "second concurrent call must ride the in-flight promise");
  assert.deepEqual(a.items, b.items);
});
