/**
 * Catalogue food search — the one place the ranking SQL lives.
 *
 * Serves GET /api/catalog/foods/search (routes/catalog.js), which feeds the
 * Add Food modal (meal_app/api/addFood/). Reads catalog_foods ⋈
 * catalog_food_servings (is_default) ⋈ nutrition_profiles ⟕ catalog_brands.
 * Every hit carries its default serving AND that serving's full nutrition
 * profile, so the client can log a food with one tap and no detail lookup.
 *
 * Ranking is the 22/22 result from the 2026-09-05 experiment
 * (claude_memory/database redesign/test results/scripts/search_ranking.js),
 * ported here verbatim in spirit. The rules that were measured, not guessed:
 *
 *   - WHERE uses the `<%` OPERATOR, never `word_similarity(...) > x`. The
 *     operator plans a Bitmap Index Scan on catalog_foods_normalized_name_trgm
 *     (27.7 ms); the function form seq-scans 49k rows (172.8 ms). Same answers.
 *   - No `base_name = q` in the WHERE. Such a row already scores
 *     word_similarity 1.0 so `<%` catches it, and ORing an unindexed equality
 *     onto an indexed operator forces the seq scan straight back.
 *   - ORDER BY tiers: word-set containment (lets "olive oil" reach AUSNUT's
 *     inverted "Oil, olive") → generic before branded → source_derivation
 *     quality → base_name = q → word_similarity → household serving (p1-02,
 *     see below) → fewer words → fewer segments → shorter name.
 *
 * Generic-before-branded (device pass 2026-09-21): the first port ranked
 * source_derivation straight after containment, meaning to say "a lab-analysed
 * AUSNUT generic beats a crowdsourced label of the same name". But that scale
 * only orders AUSNUT rows among themselves (analysed > recipe > imputed >
 * borrowed > estimated), while every Open Food Facts row is 'label_data',
 * which sits ABOVE 'recipe'. 2,001 of the 3,741 AUSNUT generics are recipe-
 * derived (every cooked variant: fried egg, boiled rice, roast chicken), so
 * "fried egg" opened with seven Egg Fried Rice labels and the actual fried
 * egg sat at rank 8. The reference food is the generic; branded products are
 * variants of it and have their own refine chip. source_derivation now breaks
 * ties inside the generic tier, which is the only comparison it was built for.
 *
 * Within-group tiebreak (checklist p1-02, added 2026-09-18): the experiment
 * asserted only the top hit's base_name, so the order INSIDE a group was
 * arbitrary — "chicken" returned skin, liver, mince, separable fat before
 * breast/thigh/wing, purely because those names have fewer words. Rows whose
 * default serving is a household measure ("1 thigh, large (174 g)") now rank
 * above rows whose default serving is a bare "100 g" / "100 ml". Cheap, and
 * it reflects what a person logging a meal is looking for. A popularity
 * signal fed by meal_logs replaces this heuristic later (p6-05).
 *
 * Cache: in-memory, 30 min, LRU-capped, in-flight dedupe, and it NEVER stores
 * a failure (ERROR_LOG 065 layer 3: a timeout cached as "no image" for 24 h).
 * hasCachedCatalogSearch() shares buildCacheKey() with searchCatalogFoods()
 * so the limiter probe in server.js can never disagree with the handler
 * about what is cached (same reason services/mealAPI.js has planSearchQueries).
 */

import { sql } from "drizzle-orm";

import { db } from "../config/db.js";

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
export const QUERY_MAX_LENGTH = 80;
const FACET_LIMIT = 8;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

/**
 * @typedef {Object} CatalogFoodHit
 * @property {string} public_id          'food_…' typed public id
 * @property {string} title              catalog_foods.name verbatim (AUSNUT comma form, or the OFF product name)
 * @property {string|null} base_name     AUSNUT head noun ('chicken'); OFF rows carry their whole name
 * @property {string[]} name_segments    ordered AUSNUT clauses after the head noun; [] for OFF rows
 * @property {string|null} brand         catalog_brands.name, null for generic foods
 * @property {'generic'|'branded'|string} food_type
 * @property {string} source_name        'ausnut_2023' | 'openfoodfacts' | …
 * @property {string|null} source_derivation  analysed | label_data | recipe | imputed | borrowed | estimated | null
 * @property {string|null} image_url
 * @property {{ id: number, description: string, grams_equivalent: number|null, metric_amount: number|null, metric_unit: string|null }} serving
 * @property {{ energy_kj: number|null, calories_kcal: number|null, protein_g: number|null, fat_g: number|null,
 *              carbohydrate_g: number|null, fiber_g: number|null, sugar_g: number|null, sodium_mg: number|null,
 *              vitamin_a_mcg: number|null, vitamin_a_convention: string|null }} nutrition
 *   Vitamin A is returned WITH its convention and must never be compared across conventions (decided 2026-09-03).
 */

/**
 * @typedef {Object} CatalogSearchResult
 * @property {CatalogFoodHit[]} items
 * @property {{ segments: Array<{ value: string, label: string, count: number }>,
 *              sources: { generic: number, branded: number } }} facets
 *   `value` === `label`: the segment with its trailing "(…)" qualifier stripped; send it back as ?segment= to filter.
 * @property {{ query: string, limit: number, offset: number, total_relevant: number, total_candidates: number }} meta
 *   total_relevant = rows containing every query word (what facets describe); total_candidates = the fuzzy `<%` set.
 */

// ---------------------------------------------------------------------------
// Parameter normalisation. Exported so the route validates with the SAME code
// the cache key is built from.
// ---------------------------------------------------------------------------

export const normalizeQuery = (raw) =>
  String(raw ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s&'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, QUERY_MAX_LENGTH);

const normalizeSegments = (raw) => {
  const list = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw];
  const cleaned = list
    .map((s) => String(s ?? "").trim().toLowerCase())
    .filter((s) => s.length > 0 && s.length <= 120);
  return Array.from(new Set(cleaned)).sort();
};

const normalizeSource = (raw) => {
  const value = String(raw ?? "").trim().toLowerCase();
  return value === "generic" || value === "branded" ? value : null;
};

const clampInt = (raw, { fallback, min, max }) => {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

/**
 * Turn raw request input into the canonical parameter set. Returns
 * { ok: false, error } for input the route should 400 on.
 */
export const parseSearchParams = (input = {}) => {
  const query = normalizeQuery(input.q ?? input.query);
  if (!query) return { ok: false, error: "Missing or empty query (q)." };
  return {
    ok: true,
    params: {
      query,
      segments: normalizeSegments(input.segment ?? input.segments),
      source: normalizeSource(input.source),
      limit: clampInt(input.limit, { fallback: SEARCH_LIMIT_DEFAULT, min: 1, max: SEARCH_LIMIT_MAX }),
      offset: clampInt(input.offset, { fallback: 0, min: 0, max: 5000 }),
    },
  };
};

export const buildCacheKey = ({ query, segments, source, limit, offset }) =>
  `catalog.search:${query}|${segments.join(",")}|${source ?? ""}|${limit}|${offset}`;

// ---------------------------------------------------------------------------
// Cache: Map preserves insertion order, so deleting + re-inserting on read
// gives LRU for free; the oldest key is Map.keys().next().
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
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  return value;
};

/** Rate-limiter probe: true when the handler will answer from cache. */
export const hasCachedCatalogSearch = (params) => readCache(buildCacheKey(params)) !== null;

/** Test hook. */
export const clearCatalogSearchCache = () => {
  cache.clear();
  inFlight.clear();
};

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

// Lower-cased word set of a text, order-independent. Runs only on rows that
// survived the indexed `<%` filter, so it is cheap (7–62 ms server-side).
const WORDS = (expr) => sql`(
  select coalesce(array_agg(w), '{}'::text[])
  from unnest(regexp_split_to_array(lower(${expr}), '[^a-z0-9]+')) w
  where w <> ''
)`;

// Numeric columns arrive as strings from the pg driver; cast in SQL so the
// JSON the route returns carries numbers.
const F8 = (col) => sql`(${col})::float8`;

// "full strength (alcohol 4-4.9% v/v)" → "full strength". The one definition
// used by both the facet GROUP BY and the segment filter, so a chip a user
// taps always selects exactly the rows it was counted from.
const SEG_LABEL = (expr) => sql`btrim(regexp_replace(${expr}, '\\s*\\([^)]*\\)\\s*$', ''))`;

export const buildSearchSql = ({ query, segments, source, limit, offset }) => {
  const filters = [sql`f.is_active`, sql`(${query} <% f.normalized_name)`];
  // Segment filter matches on the LABEL (stored segment with its trailing
  // "(…)" qualifier removed), because that is what the refine chip shows and
  // several stored segments share one label ("full strength (alcohol 4-4.9%
  // v/v)" and "full strength (alcohol 5% v/v & above)" are both "full
  // strength"). One EXISTS per selected label, ANDed. This cannot use the
  // name_segments GIN index, and does not need to: it runs only on the rows
  // the indexed `<%` filter already admitted (at most a few thousand).
  for (const label of segments) {
    filters.push(sql`exists (
      select 1 from unnest(f.name_segments) seg
      where ${SEG_LABEL(sql`seg`)} = ${label}
    )`);
  }
  if (source === "generic") filters.push(sql`f.food_type = 'generic'`);
  if (source === "branded") filters.push(sql`f.food_type <> 'generic'`);

  return sql`
    with candidates as (
      select
        f.public_id,
        f.name,
        f.base_name,
        coalesce(f.name_segments, '{}'::text[]) as name_segments,
        f.food_type,
        f.source_name,
        f.primary_image_url,
        b.name as brand,
        s.id as serving_id,
        s.description as serving_description,
        ${F8(sql`s.grams_equivalent`)} as grams_equivalent,
        ${F8(sql`s.metric_amount`)} as metric_amount,
        s.metric_unit,
        p.source_derivation,
        ${F8(sql`p.energy_kj`)} as energy_kj,
        ${F8(sql`p.calories_kcal`)} as calories_kcal,
        ${F8(sql`p.protein_g`)} as protein_g,
        ${F8(sql`p.fat_g`)} as fat_g,
        ${F8(sql`p.carbohydrate_g`)} as carbohydrate_g,
        ${F8(sql`p.fiber_g`)} as fiber_g,
        ${F8(sql`p.sugar_g`)} as sugar_g,
        ${F8(sql`p.sodium_mg`)} as sodium_mg,
        ${F8(sql`p.vitamin_a_mcg`)} as vitamin_a_mcg,
        p.vitamin_a_convention,
        ${WORDS(sql`f.name`)} as name_words,
        word_similarity(${query}, f.normalized_name) as wsim
      from catalog_foods f
      left join catalog_brands b on b.id = f.brand_id
      join catalog_food_servings s on s.food_id = f.id and s.is_default
      join nutrition_profiles p on p.id = s.nutrition_profile_id
      where ${sql.join(filters, sql` and `)}
    ),
    query_words as (
      select ${WORDS(sql`${query}`)} as words
    ),
    ranked as (
      select
        c.*,
        ((select words from query_words) <@ c.name_words) as covered,
        row_number() over (
          order by
            ((select words from query_words) <@ c.name_words) desc,
            (c.food_type = 'generic') desc,
            case c.source_derivation
              when 'analysed'   then 1
              when 'label_data' then 2
              when 'recipe'     then 3
              when 'imputed'    then 4
              when 'borrowed'   then 5
              when 'estimated'  then 6
              else 7
            end,
            (c.base_name = ${query}) desc,
            c.wsim desc,
            (c.serving_description !~* '^\\s*100\\s*(g|ml)\\s*$') desc,
            cardinality(c.name_words),
            cardinality(c.name_segments),
            length(c.name),
            c.public_id
        ) as rn
      from candidates c
    ),
    page as (
      select * from ranked where rn > ${offset} order by rn limit ${limit}
    ),
    -- Facets describe the RELEVANT rows, not the fuzzy candidate set: for
    -- "beer" the trigram filter also admits every "beef" row, and a refine
    -- row offering "steak" under a beer search is wrong. Relevant = every
    -- query word appears in the name. When nothing is covered (a typo such
    -- as "chiken"), fall back to the best 50 ranked rows so the row is not
    -- empty.
    facet_base as (
      select * from ranked r
      where r.covered
         or (not exists (select 1 from ranked where covered) and r.rn <= 50)
    ),
    seg_counts as (
      select label as value, count(distinct public_id)::int as count
      from (
        select fb.public_id, ${SEG_LABEL(sql`seg`)} as label
        from facet_base fb, unnest(fb.name_segments) as seg
      ) labelled
      where label <> ''
        and not (label = any ((select words from query_words)::text[]))
      group by label
      having count(distinct public_id) < (select count(*) from facet_base)
      order by count desc, label
      limit ${FACET_LIMIT}
    )
    select
      (select coalesce(json_agg(json_build_object(
          'public_id', p.public_id,
          'title', p.name,
          'base_name', p.base_name,
          'name_segments', p.name_segments,
          'brand', p.brand,
          'food_type', p.food_type,
          'source_name', p.source_name,
          'source_derivation', p.source_derivation,
          'image_url', p.primary_image_url,
          'serving', json_build_object(
            'id', p.serving_id,
            'description', p.serving_description,
            'grams_equivalent', p.grams_equivalent,
            'metric_amount', p.metric_amount,
            'metric_unit', p.metric_unit
          ),
          'nutrition', json_build_object(
            'energy_kj', p.energy_kj,
            'calories_kcal', p.calories_kcal,
            'protein_g', p.protein_g,
            'fat_g', p.fat_g,
            'carbohydrate_g', p.carbohydrate_g,
            'fiber_g', p.fiber_g,
            'sugar_g', p.sugar_g,
            'sodium_mg', p.sodium_mg,
            'vitamin_a_mcg', p.vitamin_a_mcg,
            'vitamin_a_convention', p.vitamin_a_convention
          )
        ) order by p.rn), '[]'::json) from page p) as items,
      (select coalesce(json_agg(json_build_object('value', value, 'count', count) order by count desc, value), '[]'::json)
         from seg_counts) as segment_facets,
      (select count(*) filter (where food_type = 'generic') from facet_base)::int as generic_count,
      (select count(*) filter (where food_type <> 'generic') from facet_base)::int as branded_count,
      (select count(*) from facet_base)::int as total_relevant,
      (select count(*) from candidates)::int as total_candidates
  `;
};

const parseJsonColumn = (value) => (typeof value === "string" ? JSON.parse(value) : value);

const runSearch = async (params) => {
  const result = await db.execute(buildSearchSql(params));
  const row = (Array.isArray(result) ? result : result?.rows ?? [])[0] ?? {};
  const items = parseJsonColumn(row.items) ?? [];
  // value and label are the same string: the facet is already grouped by
  // label in SQL, and ?segment= takes that label back.
  const segments = (parseJsonColumn(row.segment_facets) ?? []).map((f) => ({
    value: f.value,
    label: f.value,
    count: Number(f.count) || 0,
  }));
  /** @type {CatalogSearchResult} */
  return {
    items,
    facets: {
      segments,
      sources: {
        generic: Number(row.generic_count) || 0,
        branded: Number(row.branded_count) || 0,
      },
    },
    meta: {
      query: params.query,
      limit: params.limit,
      offset: params.offset,
      total_relevant: Number(row.total_relevant) || 0,
      total_candidates: Number(row.total_candidates) || 0,
    },
  };
};

/**
 * @param {ReturnType<typeof parseSearchParams>['params']} params  from parseSearchParams()
 * @returns {Promise<CatalogSearchResult & { cached: boolean }>}
 */
export const searchCatalogFoods = async (params) => {
  const key = buildCacheKey(params);
  const cached = readCache(key);
  if (cached) return { ...cached, cached: true };

  const pending = inFlight.get(key);
  if (pending) return pending.then((value) => ({ ...value, cached: true }));

  const promise = runSearch(params)
    .then((value) => writeCache(key, value))
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  // A rejected promise is not cached: writeCache runs only in .then.
  return promise.then((value) => ({ ...value, cached: false }));
};
