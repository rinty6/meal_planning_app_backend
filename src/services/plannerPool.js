// The planner's candidate pool (checklist m5-01).
//
// Every food a plate can be built from, loaded from the catalogue ONCE and
// kept in server memory. Measured 2026-11-18: the full query takes 0.8 to
// 1.7 s from a laptop and returns ~2,150 foods (~1.4 MB), and it is the same
// for every user. Per request the planner only filters this array, so no
// database or internet call sits on the planning screen's path.
//
// What is in the pool, decided by the user on 2026-11-19:
//   servable generic foods only (catalog_foods.servability = 'servable')
//   no discretionary foods, on any plate (D3)
//   no alcohol (m0-07)
//   only food groups the meal table puts on plates (D2, mealTable.js)
//
// Allergens and diets are NOT filtered here, because they differ per user.
// Each food carries its verdicts, and candidatesForMeal() applies
// foodAttributeFilter.evaluateFood to them: the same two safety rules the SQL
// filter uses (unknown is never free; a missing row is unknown), already
// tested against live rows.
//
// Nutrition travels PER 100 g plus the food's list of servings (name and
// grams). Every servable profile is stored in grams of its own serving
// (checked 2026-11-19: 6,502 of 6,502), so per-100 g is an exact division and
// the app can rescale a portion without asking the server (plate editing,
// PLANNER_PLATE_EDIT.html). Unknown nutrients stay null, never 0.
import { sql } from "drizzle-orm";

import { attributeVerdictsSql, evaluateFood, normalizeAllergens, normalizeDiets } from "./foodAttributeFilter.js";
import { kindFor, rolesFor } from "./mealTable.js";

export const POOL_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export const NUTRIENT_KEYS = Object.freeze([
  "energy_kj", "calories_kcal", "protein_g", "fat_g", "saturated_fat_g", "trans_fat_g",
  "polyunsaturated_fat_g", "monounsaturated_fat_g", "cholesterol_mg", "carbohydrate_g",
  "sugar_g", "fiber_g", "sodium_mg", "potassium_mg", "calcium_mg", "iron_mg",
  "vitamin_a_mcg", "vitamin_c_mg", "vitamin_d_mcg", "alcohol_g",
]);

const ADG_KEYS = Object.freeze(["grain", "vegetable", "fruit", "dairy", "protein"]);

// The planner screen's allergen labels -> foodAttributeFilter slugs or groups.
// Every label the screen offers MUST be here: an unmapped label would be
// dropped by normalizeAllergens, and the user would get no protection from it.
// candidatesForMeal refuses to build plates if that ever happens.
export const PLANNER_ALLERGEN_LABELS = Object.freeze({
  egg: "egg",
  fish: "fish",
  gluten: "gluten",
  lactose: "lactose",
  milk: "milk",
  nuts: "treenut",
  peanuts: "peanut",
  sesame: "sesame",
  shellfish: "shellfish",
  soy: "soy",
});

/** Planner labels ("Nuts") -> filter slugs/groups ("treenut"), unknowns kept for the guard. */
export const mapPlannerAllergens = (labels = []) =>
  (Array.isArray(labels) ? labels : [labels])
    .map((label) => String(label ?? "").trim())
    .filter(Boolean)
    .map((label) => PLANNER_ALLERGEN_LABELS[label.toLowerCase()] ?? label);

// Preparation and descriptor words that make a poor short name: "Salmon,
// baked" stays "Salmon", but "Rice, brown" becomes "Brown rice".
const NOT_A_QUALIFIER = new Set([
  "raw", "cooked", "boiled", "baked", "roasted", "fried", "grilled", "steamed", "stewed",
  "poached", "fresh", "frozen", "canned", "dried", "peeled", "unpeeled", "drained",
  "homemade", "commercial", "takeaway", "regular", "plain", "cow", "fluid", "whole",
  "lean", "untrimmed", "trimmed", "uncooked", "prepared", "purchased", "mixed",
  "unsweetened", "sweetened", "flavoured", "unflavoured", "natural", "all", "any",
]);

const capitalise = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

// Qualifiers that only make sense as part of a longer phrase: "Egg, chicken"
// is just "Egg", "Tofu, skin" is not "Skin tofu".
const QUALIFIER_SKIP_FOR_BASE = Object.freeze({ egg: new Set(["chicken"]) });
const NOT_A_FRONT_QUALIFIER = new Set(["skin", "pulp", "croutons", "juice", "flesh", "meat", "mixed"]);
// Cuts and styles read after the food: "Chicken, breast" -> "Chicken breast".
const AFTER_QUALIFIER = new Set([
  "breast", "thigh", "drumstick", "wing", "fillet", "leg", "schnitzel", "nugget", "patty",
  "mince", "steak", "chop", "cutlet", "sausage", "burger", "rissole", "kebab", "roll", "curry",
]);

/** "Rice, brown, cooked" -> "Brown rice". Falls back to the first clause of the name. */
export const shortNameFor = ({ name, baseName, nameSegments } = {}) => {
  const rawBase = String(baseName || String(name || "").split(",")[0] || "").trim().toLowerCase();
  // "tofu (soy bean curd)" -> "tofu"
  const base = rawBase.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (!base) return String(name || "").trim();
  const first = String((nameSegments || [])[0] || "").trim().toLowerCase();
  // P4, 2026-11-20: "Dip, hummus (hommus), commercial" is "Hummus", not
  // "Dip": the dip's own name is what a snack card shows ("Carrot & hummus").
  if (base === "dip" && first) {
    const dipName = first.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    if (dipName && !NOT_A_QUALIFIER.has(dipName)) return capitalise(dipName);
  }
  const isOneWord = first && !/\s/.test(first) && !/[()%&\d/]/.test(first);
  const skip = NOT_A_QUALIFIER.has(first) || NOT_A_FRONT_QUALIFIER.has(first) || QUALIFIER_SKIP_FOR_BASE[base]?.has(first);
  // "Melon, watermelon" -> "Watermelon", not "Watermelon melon".
  if (isOneWord && !skip && first.includes(base)) return capitalise(first);
  if (isOneWord && AFTER_QUALIFIER.has(first)) return capitalise(`${base} ${first}`);
  if (isOneWord && !skip && !base.includes(first)) {
    return capitalise(`${first} ${base}`);
  }
  return capitalise(base);
};

const finiteOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const round = (value, places = 4) => {
  if (value === null) return null;
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

/**
 * One SQL row -> one pool food. Pure, so the shape is tested without a
 * database. Returns null for a row that cannot be planned with (no grams on
 * the default serving, or no energy figure).
 */
export const toPoolFood = (row) => {
  const basisGrams = finiteOrNull(row.basis_quantity);
  if (!basisGrams || basisGrams <= 0) return null;

  const per100g = {};
  for (const key of NUTRIENT_KEYS) {
    const v = finiteOrNull(row[key]);
    per100g[key] = v === null ? null : round((v / basisGrams) * 100);
  }
  if (per100g.energy_kj === null && per100g.calories_kcal === null) return null;

  const serves100g = {};
  for (const key of ADG_KEYS) serves100g[key] = finiteOrNull(row[`${key}_serves`]) ?? 0;

  const servings = (Array.isArray(row.servings) ? row.servings : [])
    .map((s) => ({ description: String(s.description || "").trim(), grams: finiteOrNull(s.grams), isDefault: !!s.is_default }))
    .filter((s) => s.description && s.grams && s.grams > 0);

  return {
    id: Number(row.id),
    publicId: row.public_id,
    name: row.name,
    shortName: shortNameFor({ name: row.name, baseName: row.base_name, nameSegments: row.name_segments }),
    group: row.subgroup_code,
    image: row.image_url || null,
    defaultGrams: basisGrams,
    per100g,
    serves100g,
    servings,
    verdicts: row.verdicts && typeof row.verdicts === "object" ? row.verdicts : {},
  };
};

/** The one pool query. Exported so a test can assert its exclusions are present. */
export const buildPoolSql = () => sql`
  select
    f.id, f.public_id, f.name, f.base_name, f.name_segments,
    grp.slug as subgroup_code,
    p.basis_quantity::float8 as basis_quantity,
    ${sql.join(NUTRIENT_KEYS.map((k) => sql`${sql.raw(`p.${k}`)}::float8 as ${sql.raw(k)}`), sql`, `)},
    a.grain_serves::float8 as grain_serves, a.vegetable_serves::float8 as vegetable_serves,
    a.fruit_serves::float8 as fruit_serves, a.dairy_serves::float8 as dairy_serves,
    a.protein_serves::float8 as protein_serves,
    (select i.url from food_images i where i.food_id = f.id order by i.is_primary desc, i.sort_order limit 1) as image_url,
    (select coalesce(json_agg(json_build_object(
        'description', s2.description, 'grams', s2.grams_equivalent::float8, 'is_default', s2.is_default)
        order by s2.grams_equivalent), '[]'::json)
       from catalog_food_servings s2 where s2.food_id = f.id and s2.grams_equivalent is not null) as servings,
    ${attributeVerdictsSql("f.id")} as verdicts
  from catalog_foods f
  join catalog_food_servings s on s.food_id = f.id and s.is_default
  join nutrition_profiles p on p.id = s.nutrition_profile_id
  join food_categories fc on fc.food_id = f.id and fc.is_primary
  join categories c on c.id = fc.category_id
  join categories grp on grp.id = c.parent_id
  left join food_adg_serves a on a.food_id = f.id
  where f.servability = 'servable'
    and f.is_active
    and coalesce(p.alcohol_g, 0) = 0
    and not exists (
      select 1 from food_attributes fa join attributes at on at.id = fa.attribute_id
      where fa.food_id = f.id and at.slug = 'discretionary-food' and fa.value = 1)`;

// Foods the servability classifier marked "servable" that are not eaten as
// they are, found while building real plates on 2026-11-19: fresh herbs
// ("Thyme, fresh, raw" offered as a 100 g vegetable side), powders ("Soy
// beverage, powder") and uncooked dry legumes and grains ("Lentil, dried").
// They stay searchable and loggable; they just never go on a plate. The real
// fix is in tools/food_classify (checklist note on m5-01).
const NOT_ON_A_PLATE = [
  /^(thyme|parsley|basil|coriander|mint|chives|dill|rosemary|oregano|sage|tarragon|marjoram|lemongrass|bay leaf|garlic|ginger|chilli|chili)\b/i,
  /\bpowder\b/i,
  /\b(wrapper|pastry sheet)\b/i, // "Rice paper wrapper": an ingredient
  /^(lemon|lime)\b|\b(peel|zest|preserved lemon)\b/i, // flavourings, not a fruit serve
  /\bbreadcrumbs?\b/i, // "Breadcrumbs for coating food": an ingredient
  /\buncooked\b|\bpsyllium\b/i, // "Oats, rolled, uncooked" offered as a dinner side (m5-03 check)
  // P1, 2026-11-20: found in the 300-plate check of 2026-11-19 (HOW_AUSTRALIANS_EAT.html).
  /^infant\b/i, // "Infant pasta, added Fe": made for babies, not for an adult's plate
  // Evaporated and condensed milk are cooking ingredients, never a glass of
  // milk ("Muesli + passionfruit + evaporated milk"). Limited to milk so a
  // condensed soup is judged by its own rules.
  /\b(evaporated|condensed)\b.*\bmilk\b|\bmilk\b.*\b(evaporated|condensed)\b/i,
  /^panettone\b|^bun, sweet\b/i, // sweet bakery, offered as breakfast and as a side
  /^(semolina|tapioca)\b/i, // ingredients, not sides
];
// P1, 2026-11-20: "dry" as well as "dried" ("Lentil, green, hulled, dry" got
// past the old rule onto a dinner plate).
const DRY_UNCOOKED = /\b(dried|dry)\b/i;
const COOKED_WORDS = /\b(boiled|cooked|canned|soaked|stewed|steamed|microwaved|baked|roasted)\b/i;
const DRY_GROUPS = new Set(["ausnut-251", "ausnut-121"]); // legumes; grains and flours

/** True when a food may go on a plate at all, whatever its group. */
export const isPlateWorthy = (row) => {
  const name = String(row?.name || "");
  if (NOT_ON_A_PLATE.some((re) => re.test(name))) return false;
  if (DRY_GROUPS.has(row?.subgroup_code) && DRY_UNCOOKED.test(name) && !COOKED_WORDS.test(name)) return false;
  return true;
};

/** Rows -> pool, keeping only foods whose group can go on a plate. */
export const buildPool = (rows = []) => {
  const foods = [];
  for (const row of rows) {
    if (kindFor(row.subgroup_code) !== "plate") continue;
    if (!isPlateWorthy(row)) continue;
    const food = toPoolFood(row);
    if (food) foods.push(food);
  }
  return foods;
};

let cached = null;
let inFlight = null;

/**
 * The pool, loaded at most once per POOL_MAX_AGE_MS. Concurrent callers share
 * one load. A failed load is not cached, so the next request retries.
 */
export const getPlannerPool = async ({ db, now = Date.now(), maxAgeMs = POOL_MAX_AGE_MS } = {}) => {
  if (cached && now - cached.loadedAt < maxAgeMs) return cached.foods;
  if (!inFlight) {
    inFlight = (async () => {
      const result = await db.execute(buildPoolSql());
      const rows = Array.isArray(result) ? result : result?.rows ?? [];
      const foods = buildPool(rows);
      cached = { foods, loadedAt: Date.now() };
      return foods;
    })().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
};

export const clearPlannerPool = () => {
  cached = null;
};

/**
 * The foods one user may get as mains and sides in one meal.
 *
 * Refuses (returns blocked) when an allergen or diet label could not be
 * understood: building plates without that filter would be the one failure
 * this must never have.
 *
 * @returns {{ mains: object[], sides: object[], blocked: string[] }}
 */
export const candidatesForMeal = (pool, meal, { allergens = [], diets = [], strictness = {} } = {}) => {
  const mapped = mapPlannerAllergens(allergens);
  const unknownAllergens = normalizeAllergens(mapped).ignored;
  const unknownDiets = normalizeDiets(diets).ignored;
  const blocked = [...unknownAllergens, ...unknownDiets].map(String);
  if (blocked.length > 0) return { mains: [], sides: [], blocked };

  const mains = [];
  const sides = [];
  for (const food of pool) {
    const roles = rolesFor(food.group, meal);
    if (roles.length === 0) continue;
    if (!evaluateFood(food.verdicts, { allergens: mapped, diets, strictness }).passes) continue;
    if (roles.includes("main")) mains.push(food);
    if (roles.includes("side")) sides.push(food);
  }
  return { mains, sides, blocked };
};
