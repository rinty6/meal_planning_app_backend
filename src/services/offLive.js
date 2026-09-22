/**
 * Open Food Facts live lookup — the fallback for a barcode our catalogue does
 * not hold (checklist b1-05, b1-06).
 *
 * This is the ONLY place the app talks to OFF at request time. It exists
 * because 46,002 imported products cannot cover a shelf: a new SKU, a
 * relabelled pack or a product outside the AU export all miss, and a miss that
 * OFF can answer should not send the user to the report form.
 *
 * The mapping rules here are deliberately the same ones as
 * tools/off_extract/extract.py, because a product mapped by a second, looser
 * code path would put numbers into meal_logs that our own import would have
 * rejected:
 *
 *   - Read the `*_100g` fields, never the label `value`. OFF's per-row basis
 *     is per-serving on ~40% of AU rows.
 *   - The `100g` figures are mass fractions in GRAMS, so mg and mcg columns
 *     are scaled out of grams (sodium 0.4 -> 400 mg, not 0.4).
 *   - Physiological ceilings reject contributor typos that no error tag
 *     catches (21,200 kcal per 100 g exists in the real file).
 *   - The energy pair is reconciled at 4.184 kJ/kcal with kJ surviving, which
 *     is what AU labels declare by law and what reconstructed better across
 *     the 3,331 contradictory products measured during the import.
 *   - A product missing any of the seven FSANZ panel values is REJECTED, not
 *     half-filled. The report form handles it instead, and the user's own
 *     numbers are better than our guess.
 *
 * What comes back is display-only and flagged unverified. It is never written
 * into catalog_foods: that would publish an ODbL derivative without the
 * attribution the bulk import carries, and it would skip the quality gate the
 * importer applies (checklist b0-01).
 */

const OFF_ENDPOINT = "https://world.openfoodfacts.org/api/v2/product";
const TIMEOUT_MS = 3000;

// OFF asks every client to identify itself; an anonymous UA gets throttled.
const USER_AGENT = "GoodHealthMate/1.0 (https://goodhealthmate.com; support@goodhealthmate.com)";

// The seven values FSANZ legally requires on an Australian Nutrition
// Information Panel. Energy is satisfied by either member of the pair.
const PANEL_REQUIRED = ["proteins", "carbohydrates", "fat", "saturated-fat", "sodium", "sugars"];

// OFF nutriment -> (our column, scale out of grams). Same table as extract.py.
const NUTRIENTS = {
  "energy-kcal": ["calories_kcal", 1],
  "energy-kj": ["energy_kj", 1],
  proteins: ["protein_g", 1],
  carbohydrates: ["carbohydrate_g", 1],
  fat: ["fat_g", 1],
  "saturated-fat": ["saturated_fat_g", 1],
  "trans-fat": ["trans_fat_g", 1],
  "polyunsaturated-fat": ["polyunsaturated_fat_g", 1],
  "monounsaturated-fat": ["monounsaturated_fat_g", 1],
  fiber: ["fiber_g", 1],
  sugars: ["sugar_g", 1],
  "added-sugars": ["added_sugars_g", 1],
  cholesterol: ["cholesterol_mg", 1000],
  sodium: ["sodium_mg", 1000],
  potassium: ["potassium_mg", 1000],
  calcium: ["calcium_mg", 1000],
  iron: ["iron_mg", 1000],
  "vitamin-c": ["vitamin_c_mg", 1000],
  "vitamin-d": ["vitamin_d_mcg", 1000000],
  "vitamin-a": ["vitamin_a_mcg", 1000000],
};

const GRAM_MAX = 100;
const CEILINGS = {
  calories_kcal: 900,
  energy_kj: 3800,
  sodium_mg: 40000,
  potassium_mg: 55000,
  calcium_mg: 40000,
  iron_mg: 1000,
  cholesterol_mg: 5000,
  vitamin_c_mg: 100000,
  vitamin_d_mcg: 10000,
  vitamin_a_mcg: 100000,
};

const KJ_PER_KCAL = 4.184;
const round4 = (v) => Math.round(v * 10000) / 10000;

const cleanText = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
};

/** `brands` is free text, comma separated for multi-brand products. */
export const firstBrand = (raw) => {
  const text = cleanText(raw);
  if (!text) return null;
  const first = cleanText(text.split(",")[0]);
  return first && first.length <= 100 ? first : null;
};

/**
 * Map an OFF `product` object onto our nutrition columns, per 100 g.
 * Returns null when the panel is incomplete or an impossible value makes one
 * of the required columns unusable.
 */
export const mapOffNutrients = (product) => {
  const nutriments = product?.nutriments;
  if (!nutriments || typeof nutriments !== "object") return null;

  const out = {};
  const rejected = new Set();
  for (const [offName, [column, scale]] of Object.entries(NUTRIENTS)) {
    const raw = nutriments[`${offName}_100g`];
    if (raw === null || raw === undefined || raw === "") continue;
    const value = Number(raw) * scale;
    if (!Number.isFinite(value)) continue;
    const impossible =
      value < 0 ||
      (column.endsWith("_g") && value > GRAM_MAX) ||
      value > (CEILINGS[column] ?? Infinity);
    if (impossible) {
      rejected.add(offName);
      continue;
    }
    out[column] = round4(value);
  }

  for (const required of PANEL_REQUIRED) {
    const [column] = NUTRIENTS[required];
    if (out[column] === undefined) return null;
  }

  // Keep the energy pair internally consistent rather than storing two
  // contributor figures that contradict each other. kJ wins when present.
  if (out.energy_kj !== undefined) {
    out.calories_kcal = round4(out.energy_kj / KJ_PER_KCAL);
  } else if (out.calories_kcal !== undefined) {
    out.energy_kj = round4(out.calories_kcal * KJ_PER_KCAL);
  } else {
    return null; // no usable energy at all
  }

  return out;
};

/**
 * Servings, mirroring extract.py: every product gets a 100 g serving because
 * that is the basis OFF publishes, and the label serving is added when it
 * parses and is not itself 100 g.
 */
export const mapOffServings = (product) => {
  const servings = [{
    id: null,
    source_record_id: "synthetic:100g",
    description: "100 g",
    grams_equivalent: 100,
    metric_amount: 100,
    metric_unit: "g",
    is_default: true,
  }];

  const grams = Number(product?.serving_quantity);
  if (Number.isFinite(grams) && grams > 0 && grams <= 5000 && Math.abs(grams - 100) > 0.01) {
    const label = cleanText(product?.serving_size);
    const trimmed = label && label.length <= 120 ? label : null;
    const gramsText = `${Number(grams.toFixed(4))} g`;
    const description = trimmed ? (/\d/.test(trimmed) ? trimmed : `${trimmed} (${gramsText})`) : gramsText;
    if (description !== "100 g") {
      servings[0].is_default = false;
      servings.push({
        id: null,
        source_record_id: "label:serving",
        description,
        grams_equivalent: round4(grams),
        metric_amount: round4(grams),
        metric_unit: "g",
        is_default: true,
      });
    }
  }
  return servings;
};

/** Scale a per-100 g nutrition object to one serving. */
export const scaleNutrition = (per100g, grams) => {
  const factor = Number(grams) / 100;
  const out = {};
  for (const [column, value] of Object.entries(per100g)) {
    out[column] = value === null ? null : round4(value * factor);
  }
  return out;
};

/**
 * Turn an OFF API payload into the same hit shape lookupBarcode returns for a
 * catalogue row, so the client maps both with one function. Returns null when
 * the product is unusable (no name, incomplete panel, quality errors).
 */
export const mapOffProduct = (payload, barcode) => {
  if (!payload || payload.status !== 1 || !payload.product) return null;
  const product = payload.product;

  // Same gate as the import: any error tag and the product is out. It is worth
  // knowing what this costs. Nutella (3017620422003) carries
  // `en:nutrition-data-per-serving-missing-serving-size` and is rejected even
  // though its per-100 g figures are correct. That tag means OFF could not
  // prove which basis the label used, and a per-serving panel read as per-100 g
  // would put roughly a third of the real energy into someone's day. The user
  // is not stuck when we reject: the report form takes their own numbers, which
  // beat an uncertain scrape. Relaxing this to "reject only tags that concern
  // the values we read" is a real option once reports show how often it bites.
  if (Array.isArray(product.data_quality_errors_tags) && product.data_quality_errors_tags.length > 0) {
    return null;
  }

  const name = cleanText(product.product_name || product.product_name_en);
  if (!name) return null;

  const per100g = mapOffNutrients(product);
  if (!per100g) return null;

  const servings = mapOffServings(product).map((serving) => ({
    ...serving,
    nutrition: scaleNutrition(per100g, serving.grams_equivalent),
  }));
  const defaultServing = servings.find((s) => s.is_default) ?? servings[0];

  return {
    public_id: `food_off_${barcode}`,
    title: name,
    base_name: name.toLowerCase(),
    name_segments: [],
    brand: firstBrand(product.brands),
    food_type: "branded",
    source_name: "openfoodfacts_live",
    source_derivation: "label_data",
    image_url: cleanText(product.image_front_small_url || product.image_url),
    barcode,
    verification_status: "unverified",
    serving: defaultServing,
    nutrition: defaultServing.nutrition,
    servings,
  };
};

/**
 * One attempt, short timeout, never throws: a fallback that hangs is worse
 * than a fallback that misses, because the user is waiting on a camera screen.
 */
export const fetchOffProduct = async (barcode, { timeoutMs = TIMEOUT_MS, fetchImpl = fetch } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${OFF_ENDPOINT}/${encodeURIComponent(barcode)}.json`, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return mapOffProduct(payload, barcode);
  } catch {
    return null; // timeout, abort, network, malformed JSON: all "no answer"
  } finally {
    clearTimeout(timer);
  }
};
