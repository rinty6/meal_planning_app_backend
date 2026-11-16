/**
 * Barcode lookup over the self-owned catalogue, with a live Open Food Facts
 * fallback. Serves GET /api/catalog/foods/barcode/:code (routes/catalog.js),
 * which feeds the Add Food modal's scanner (meal_app/api/barcode/).
 *
 * Shape of the answer is the point of this file: a hit looks exactly like a
 * search hit plus `servings`, so the client maps a scanned food and a searched
 * food with the same function and writes the same meal_logs row.
 *
 * Every serving carries its OWN nutrition, because the importer scales a
 * profile per serving; the picker's chip row switches between them and the kJ
 * line has to follow. `item.nutrition` is the default serving's, for the card.
 *
 * Decisions that are easy to get wrong later:
 *
 *   - A MISS IS A 200 with `found: false`, never a 404 (checklist b1-07).
 *     The client layer maps a 404 to a failure kind, which would show
 *     "something went wrong" where the report form belongs (ERROR_LOG 063/065:
 *     a failure must never be rendered as an empty result, and an empty result
 *     must never be rendered as a failure).
 *   - The scanned digits are normalised and tried as a SET (b1-04). A UPC-A
 *     printed on an Australian pack is the EAN-13 with a leading zero, and
 *     ean8/upc_e come off the scanner shorter still. Without this, products we
 *     actually hold would miss and land on the report form, which looks like a
 *     data gap but is a lookup bug.
 *   - Found AND not-found are both cached; a timeout or a 5xx is not
 *     (ERROR_LOG 065 L3: a failure cached as "no result" outlives the outage).
 *     hasCachedBarcodeLookup() shares the key builder with the fetch so the
 *     limiter probe in server.js can never disagree with the handler.
 *   - The OFF fallback is display-only and never written to catalog_foods
 *     (b0-01). services/offLive.js holds that mapping and its rules.
 */

import { sql } from "drizzle-orm";

import { db } from "../config/db.js";
import { ENV } from "../config/env.js";
import { fetchOffProduct } from "./offLive.js";

export const BARCODE_MIN_LENGTH = 6;
export const BARCODE_MAX_LENGTH = 24;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;

/** Digits only. Scanners and hand entry both bring spaces, dashes and NULs. */
export const normalizeBarcode = (raw) => String(raw ?? "").replace(/\D/g, "").slice(0, BARCODE_MAX_LENGTH);

/**
 * Every form of the same number worth trying, most likely first.
 *
 * EAN-13 and UPC-A are the same GTIN: the 12-digit UPC-A on a US-sourced pack
 * is the 13-digit code with a leading zero. OFF stores whatever the
 * contributor entered, so both spellings exist in the wild and we try both.
 * UPC-E (8 digits, zero-suppressed) is NOT expanded here: the expansion is
 * ambiguous without the check digit rules, and expo-camera already reports
 * upc_e as its expanded upc_a form.
 */
export const barcodeCandidates = (code) => {
  const candidates = [code];
  if (code.length === 12) candidates.push(`0${code}`);
  if (code.length === 13 && code.startsWith("0")) candidates.push(code.slice(1));
  if (code.length === 14 && code.startsWith("0")) candidates.push(code.slice(1));
  return Array.from(new Set(candidates.filter(Boolean)));
};

/** Validate and canonicalise request input. Route 400s on { ok: false }. */
export const parseBarcodeParams = (input = {}) => {
  const barcode = normalizeBarcode(input.code ?? input.barcode);
  if (barcode.length < BARCODE_MIN_LENGTH) {
    return { ok: false, error: "That does not look like a barcode." };
  }
  return { ok: true, params: { barcode, candidates: barcodeCandidates(barcode) } };
};

export const buildBarcodeCacheKey = ({ barcode }) => `catalog.barcode:${barcode}`;

// ---------------------------------------------------------------------------
// Cache: Map keeps insertion order, so delete + re-insert on read gives LRU.
// ---------------------------------------------------------------------------

const cache = new Map();
const inFlight = new Map();

const readCache = (key) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
};

const writeCache = (key, value) => {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
};

/** Rate-limiter probe: true when the handler will answer without a query. */
export const hasCachedBarcodeLookup = (params) => readCache(buildBarcodeCacheKey(params)) !== null;

/** Test hook. */
export const clearBarcodeLookupCache = () => {
  cache.clear();
  inFlight.clear();
};

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const F8 = (col) => sql`(${col})::float8`;

// alcohol_g is grams in this serving (m4-10): 0 is a known none, null is unknown.
const NUTRITION_JSON = (alias) => sql`json_build_object(
  'energy_kj', ${F8(sql`${alias}.energy_kj`)},
  'calories_kcal', ${F8(sql`${alias}.calories_kcal`)},
  'protein_g', ${F8(sql`${alias}.protein_g`)},
  'fat_g', ${F8(sql`${alias}.fat_g`)},
  'carbohydrate_g', ${F8(sql`${alias}.carbohydrate_g`)},
  'fiber_g', ${F8(sql`${alias}.fiber_g`)},
  'sugar_g', ${F8(sql`${alias}.sugar_g`)},
  'sodium_mg', ${F8(sql`${alias}.sodium_mg`)},
  'saturated_fat_g', ${F8(sql`${alias}.saturated_fat_g`)},
  'vitamin_a_mcg', ${F8(sql`${alias}.vitamin_a_mcg`)},
  'vitamin_a_convention', ${alias}.vitamin_a_convention,
  'alcohol_g', ${F8(sql`${alias}.alcohol_g`)}
)`;

// The neon-http driver does NOT serialise a JS array into a Postgres array
// parameter (ERROR_LOG: `malformed array literal`, hit twice now). Build
// ARRAY['…','…'] out of individual placeholders instead.
const textArray = (values) =>
  sql`array[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;

export const buildLookupSql = (candidates) => sql`
  with hit as (
    select f.*, b.name as brand_name,
           array_position(${textArray(candidates)}, f.barcode) as candidate_rank
    from catalog_foods f
    left join catalog_brands b on b.id = f.brand_id
    where f.is_active and f.barcode = any (${textArray(candidates)})
    order by candidate_rank
    limit 1
  )
  select json_build_object(
    'public_id', h.public_id,
    'title', h.name,
    'base_name', h.base_name,
    'name_segments', coalesce(h.name_segments, '{}'::text[]),
    'brand', h.brand_name,
    'food_type', h.food_type,
    'source_name', h.source_name,
    'image_url', h.primary_image_url,
    'barcode', h.barcode,
    'barcode_type', h.barcode_type,
    'verification_status', h.verification_status,
    'servings', (
      select json_agg(serving order by serving->>'is_default' desc, (serving->>'sort_order')::int, (serving->>'id')::int)
      from (
        select json_build_object(
          'id', s.id,
          'description', s.description,
          'grams_equivalent', ${F8(sql`s.grams_equivalent`)},
          'metric_amount', ${F8(sql`s.metric_amount`)},
          'metric_unit', s.metric_unit,
          'is_default', s.is_default,
          'sort_order', coalesce(s.sort_order, 0),
          'source_derivation', p.source_derivation,
          'nutrition', ${NUTRITION_JSON(sql`p`)}
        ) as serving
        from catalog_food_servings s
        join nutrition_profiles p on p.id = s.nutrition_profile_id
        where s.food_id = h.id
      ) servings
    )
  ) as item
  from hit h`;

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

const offLiveEnabled = () => String(ENV.OFF_LIVE_LOOKUP ?? "true").toLowerCase() !== "false";

const shapeCatalogHit = (item) => {
  const servings = Array.isArray(item.servings) ? item.servings : [];
  const defaultServing = servings.find((s) => s.is_default) ?? servings[0] ?? null;
  return {
    ...item,
    source_derivation: defaultServing?.source_derivation ?? null,
    serving: defaultServing,
    nutrition: defaultServing?.nutrition ?? null,
    servings,
  };
};

const runLookup = async ({ barcode, candidates }) => {
  const rows = await db.execute(buildLookupSql(candidates));
  const row = (rows?.rows ?? rows)?.[0];
  const item = row?.item ?? null;

  if (item) {
    return { found: true, barcode, source: "catalog", item: shapeCatalogHit(item) };
  }

  if (offLiveEnabled()) {
    const live = await fetchOffProduct(barcode);
    if (live) return { found: true, barcode, source: "openfoodfacts_live", item: live };
  }

  return { found: false, barcode, source: null, item: null };
};

/**
 * @param {{ barcode: string, candidates: string[] }} params from parseBarcodeParams
 * @returns {Promise<{ found: boolean, barcode: string, source: string|null, item: object|null, cached: boolean }>}
 */
export const lookupBarcode = async (params) => {
  const key = buildBarcodeCacheKey(params);

  const cached = readCache(key);
  if (cached) return { ...cached, cached: true };

  const pending = inFlight.get(key);
  if (pending) return { ...(await pending), cached: true };

  const promise = runLookup(params)
    .then((result) => writeCache(key, result))
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return { ...(await promise), cached: false };
};
