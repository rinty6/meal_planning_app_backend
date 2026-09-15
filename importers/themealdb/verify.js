/**
 * TheMealDB recipe import, STAGE 3 step 3: verify the database against the JSON.
 *
 * Read-only. Writes nothing, opens no transaction.
 *
 * The division of labour matches ausnut and off: compute.js turned the source
 * into numbers, load.js moved them into Postgres, and this file asks only "is
 * what is in the database the same as what compute.js produced". It does NOT
 * re-judge whether the numbers are plausible - that is catalog_audit.js, which
 * must be re-run after this.
 *
 * It deliberately re-derives values from the JSON rather than trusting a single
 * hand-picked row, because the failure mode that matters is a systematic
 * mis-scale, which one spot check would miss.
 *
 *   node importers/themealdb/verify.js            (from backend/)
 *   node importers/themealdb/verify.js --verbose
 *
 * MUST be run from backend/ - dotenv resolves .env from process.cwd().
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';

import { ENV } from '../../src/config/env.js';
import { NUTRIENTS, SOURCE_NAME, SOURCE_LICENSE, publicIdFor } from './load.js';
import { plan, DISH_ROOT, CUISINE_ROOT, DIET_CATEGORIES } from './load_taxonomy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERBOSE = process.argv.includes('--verbose');
const read = (p) => JSON.parse(readFileSync(path.resolve(HERE, p), 'utf-8'));

const payload = read('../../../tools/themealdb_extract/out/themealdb.json');
const nutrition = read('out/recipe_nutrition.json');
const imap = read('out/ingredient_map.json').map;

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); } else {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    if (detail !== undefined) console.log(`          ${detail}`);
  }
};

const pool = new Pool({ connectionString: ENV.DB_URL });
const db = drizzle(pool);
const all = async (q) => {
  const r = await db.execute(q);
  return r.rows ?? r;
};
const one = async (q) => (await all(q))[0];
const num = (v) => (v === null || v === undefined ? null : Number(v));

try {
  const byId = new Map(nutrition.recipes.map((n) => [n.source_record_id, n]));
  const srcById = new Map(payload.recipes.map((r) => [r.source_record_id, r]));

  // ---- A. counts --------------------------------------------------------
  console.log('');
  console.log('A. COUNTS');
  const recipeCount = num((await one(sql`
    select count(*) as c from catalog_recipes where source_name = ${SOURCE_NAME}`)).c);
  check('catalog_recipes matches the source corpus',
    recipeCount === payload.recipes.length, `db ${recipeCount}, json ${payload.recipes.length}`);

  const ingCount = num((await one(sql`
    select count(*) as c from recipe_ingredients ri
    join catalog_recipes r on r.id = ri.recipe_id
    where r.source_name = ${SOURCE_NAME}`)).c);
  const expectedIng = payload.recipes.reduce((n, r) => n + r.ingredients.length, 0);
  check('recipe_ingredients matches the source', ingCount === expectedIng,
    `db ${ingCount}, json ${expectedIng}`);

  const stepCount = num((await one(sql`
    select count(*) as c from recipe_steps rs
    join catalog_recipes r on r.id = rs.recipe_id
    where r.source_name = ${SOURCE_NAME}`)).c);
  const expectedSteps = payload.recipes.reduce((n, r) => n + r.steps.length, 0);
  check('recipe_steps matches the source', stepCount === expectedSteps,
    `db ${stepCount}, json ${expectedSteps}`);

  const profCount = num((await one(sql`
    select count(*) as c from nutrition_profiles where source_name = ${SOURCE_NAME}`)).c);
  check('one nutrition_profile per recipe, no strays',
    profCount === payload.recipes.length, `db ${profCount}, expected ${payload.recipes.length}`);

  // ---- B. referential integrity ----------------------------------------
  console.log('');
  console.log('B. REFERENTIAL INTEGRITY');
  const orphanProfiles = num((await one(sql`
    select count(*) as c from nutrition_profiles p
    where p.source_name = ${SOURCE_NAME}
      and not exists (select 1 from catalog_recipes r where r.nutrition_profile_id = p.id)`)).c);
  check('no orphaned themealdb nutrition_profiles', orphanProfiles === 0, `${orphanProfiles} orphans`);

  const noIngredients = num((await one(sql`
    select count(*) as c from catalog_recipes r
    where r.source_name = ${SOURCE_NAME}
      and not exists (select 1 from recipe_ingredients ri where ri.recipe_id = r.id)`)).c);
  check('every recipe has at least one ingredient', noIngredients === 0, `${noIngredients} without`);

  const noSteps = num((await one(sql`
    select count(*) as c from catalog_recipes r
    where r.source_name = ${SOURCE_NAME}
      and not exists (select 1 from recipe_steps rs where rs.recipe_id = r.id)`)).c);
  check('every recipe has at least one step', noSteps === 0, `${noSteps} without`);

  // A recipe pointing at a profile another recipe also uses would break the
  // 1:1 the UNIQUE index promises; check it rather than trusting the index.
  const sharedProfiles = num((await one(sql`
    select count(*) as c from (
      select nutrition_profile_id from catalog_recipes
      where source_name = ${SOURCE_NAME}
      group by nutrition_profile_id having count(*) > 1) t`)).c);
  check('no two recipes share a nutrition_profile', sharedProfiles === 0, `${sharedProfiles} shared`);

  const badSteps = num((await one(sql`
    select count(*) as c from (
      select rs.recipe_id, min(rs.step_number) as lo, max(rs.step_number) as hi,
             count(*) as n
      from recipe_steps rs join catalog_recipes r on r.id = rs.recipe_id
      where r.source_name = ${SOURCE_NAME}
      group by rs.recipe_id) t
    where t.lo <> 1 or t.hi <> t.n`)).c);
  check('step numbers start at 1 and are contiguous', badSteps === 0, `${badSteps} recipes off`);

  const danglingFood = num((await one(sql`
    select count(*) as c from recipe_ingredients ri
    join catalog_recipes r on r.id = ri.recipe_id
    where r.source_name = ${SOURCE_NAME} and ri.food_id is not null
      and not exists (select 1 from catalog_foods f where f.id = ri.food_id)`)).c);
  check('every non-null food_id resolves to a real food', danglingFood === 0, `${danglingFood} dangling`);

  const servingWithoutFood = num((await one(sql`
    select count(*) as c from recipe_ingredients ri
    join catalog_recipes r on r.id = ri.recipe_id
    where r.source_name = ${SOURCE_NAME}
      and ri.food_serving_id is not null and ri.food_id is null`)).c);
  check('serving-requires-food CHECK holds', servingWithoutFood === 0);

  // ---- C. values match the JSON ----------------------------------------
  console.log('');
  console.log('C. VALUES MATCH compute.js OUTPUT');
  const dbRows = await all(sql`
    select r.source_record_id, r.title, r.yield_servings, r.total_weight_g,
           r.grams_per_serving, r.nutrition_basis, r.servings_estimated,
           r.public_id, r.primary_image_url, r.verification_status, r.is_active,
           p.basis_quantity, p.basis_unit, p.basis_state, p.carbohydrate_basis,
           p.vitamin_a_convention, p.calculation_method, p.confidence,
           p.source_name as p_source, p.source_license as p_license,
           p.source_derivation,
           ${sql.join(NUTRIENTS.map((n) => sql.raw(`p.${n}`)), sql`, `)}
    from catalog_recipes r
    join nutrition_profiles p on p.id = r.nutrition_profile_id
    where r.source_name = ${SOURCE_NAME}`);

  let mismatch = 0;
  let nutrientCells = 0;
  const problems = [];
  for (const row of dbRows) {
    const n = byId.get(row.source_record_id);
    if (!n) { mismatch += 1; problems.push(`${row.source_record_id} not in compute output`); continue; }
    const eq = (a, b, label) => {
      const A = num(a);
      const B = b === null || b === undefined ? null : Number(b);
      if (A === null && B === null) return true;
      if (A === null || B === null) { problems.push(`${row.title}: ${label} ${A} vs ${B}`); return false; }
      if (Math.abs(A - B) > 0.01) { problems.push(`${row.title}: ${label} ${A} vs ${B}`); return false; }
      return true;
    };
    let ok = true;
    ok = eq(row.yield_servings, n.yield_servings, 'yield_servings') && ok;
    ok = eq(row.total_weight_g, n.total_weight_g, 'total_weight_g') && ok;
    ok = eq(row.grams_per_serving, n.grams_per_serving, 'grams_per_serving') && ok;
    ok = eq(row.basis_quantity, n.grams_per_serving, 'basis_quantity vs grams_per_serving') && ok;
    ok = eq(row.confidence, n.covered_mass_fraction, 'confidence') && ok;
    for (const k of NUTRIENTS) { ok = eq(row[k], n.per_serving[k], k) && ok; nutrientCells += 1; }
    if (!ok) mismatch += 1;
  }
  check(`all ${nutrientCells} nutrient cells and 5 scalars match compute.js`,
    mismatch === 0, `${mismatch} recipes differ; first: ${problems.slice(0, 3).join(' | ')}`);

  // basis_quantity is the trap load.test.js guards; assert it in the DB too,
  // because a value written as 100 would be silently read as per-100 g.
  const wrongBasis = dbRows.filter((r) => Math.abs(num(r.basis_quantity)
    - Number(byId.get(r.source_record_id).grams_per_serving)) > 0.01).length;
  check('basis_quantity is grams-per-serving in every row', wrongBasis === 0, `${wrongBasis} rows`);

  const notPerServing = dbRows.filter((r) => r.nutrition_basis !== 'per_serving').length;
  check('nutrition_basis is per_serving everywhere', notPerServing === 0);

  const publicIdBad = dbRows.filter((r) => r.public_id !== publicIdFor(r.source_record_id)).length;
  check('public_id follows recipe_themealdb_<id>', publicIdBad === 0, `${publicIdBad} rows`);

  const imageMissing = dbRows.filter((r) => {
    const src = srcById.get(r.source_record_id);
    return (src.image_url ?? null) !== (r.primary_image_url ?? null);
  }).length;
  check('primary_image_url matches the source', imageMissing === 0, `${imageMissing} rows`);

  // ---- D. unknown is not zero ------------------------------------------
  console.log('');
  console.log('D. UNKNOWN IS NOT ZERO');
  let wrongNull = 0;
  for (const row of dbRows) {
    const n = byId.get(row.source_record_id);
    for (const k of n.nutrients_unknown) {
      if (row[k] !== null) { wrongNull += 1; problems.push(`${row.title}: ${k} should be NULL`); }
    }
  }
  const unknownTotal = nutrition.recipes.reduce((s, n) => s + n.nutrients_unknown.length, 0);
  check(`every unknown nutrient is NULL, not 0 (${unknownTotal} unknowns in this corpus)`,
    wrongNull === 0, `${wrongNull} stored a value`);

  // ---- E. provenance and conventions -----------------------------------
  console.log('');
  console.log('E. PROVENANCE AND CONVENTIONS');
  const uniform = (field, expected) => {
    const bad = dbRows.filter((r) => r[field] !== expected).length;
    check(`${field} is ${expected} on every row`, bad === 0, `${bad} rows differ`);
  };
  uniform('p_source', SOURCE_NAME);
  uniform('p_license', SOURCE_LICENSE);
  uniform('source_derivation', 'recipe');
  uniform('basis_state', 'prepared');
  uniform('basis_unit', 'g');
  uniform('calculation_method', 'ingredient_calculation');
  uniform('carbohydrate_basis', nutrition.carbohydrate_basis);
  uniform('vitamin_a_convention', nutrition.vitamin_a_convention);
  uniform('verification_status', 'unverified');

  // ---- F. the existing catalogue was not disturbed ----------------------
  console.log('');
  console.log('F. EXISTING CATALOGUE UNDISTURBED');
  const foods = await all(sql`
    select source_name, count(*) as c from catalog_foods group by source_name order by source_name`);
  const foodTotal = foods.reduce((s, r) => s + num(r.c), 0);
  check('catalog_foods still holds 49,743 rows', foodTotal === 49743,
    `${foodTotal}: ${foods.map((r) => `${r.source_name} ${r.c}`).join(', ')}`);

  const servings = num((await one(sql`select count(*) as c from catalog_food_servings`)).c);
  check('catalog_food_servings still holds 81,345 rows', servings === 81345, `${servings}`);

  const foodProfiles = num((await one(sql`
    select count(*) as c from nutrition_profiles where source_name <> ${SOURCE_NAME}`)).c);
  check('non-recipe nutrition_profiles still 81,345', foodProfiles === 81345, `${foodProfiles}`);

  // ---- G. live probes ---------------------------------------------------
  console.log('');
  console.log('G. LIVE PROBES');
  const probe = await one(sql`
    select r.title, r.yield_servings, r.grams_per_serving,
           p.energy_kj, p.calories_kcal, p.protein_g, p.fat_g, p.carbohydrate_g,
           (select count(*) from recipe_ingredients ri where ri.recipe_id = r.id) as ingredients,
           (select count(*) from recipe_steps rs where rs.recipe_id = r.id) as steps
    from catalog_recipes r join nutrition_profiles p on p.id = r.nutrition_profile_id
    where r.source_name = ${SOURCE_NAME} and r.source_record_id = '52764'`);
  check('a known recipe reads back end to end', Boolean(probe) && num(probe.ingredients) > 0
    && num(probe.steps) > 0 && num(probe.energy_kj) > 0,
  probe ? JSON.stringify(probe) : 'not found');
  if (probe) {
    console.log(`          ${probe.title}: ${probe.yield_servings} servings of `
      + `${num(probe.grams_per_serving).toFixed(0)} g, ${num(probe.energy_kj).toFixed(0)} kJ / `
      + `${num(probe.calories_kcal).toFixed(0)} kcal, ${probe.ingredients} ingredients, ${probe.steps} steps`);
  }

  const titleHits = await all(sql`
    select title from catalog_recipes
    where source_name = ${SOURCE_NAME} and normalized_title % 'chicken curry'
    order by word_similarity('chicken curry', normalized_title) desc limit 3`);
  check('trigram title search returns recipes', titleHits.length > 0,
    titleHits.map((r) => r.title).join(' | '));

  const unmappedExpected = payload.recipes.reduce((s, r) => s + r.ingredients.filter((ing) => {
    const e = imap[ing.name.trim().toLowerCase()];
    return !(e && (e.confidence === 'high' || e.confidence === 'medium'));
  }).length, 0);
  const unmappedDb = num((await one(sql`
    select count(*) as c from recipe_ingredients ri
    join catalog_recipes r on r.id = ri.recipe_id
    where r.source_name = ${SOURCE_NAME} and ri.food_id is null`)).c);
  check('unmapped ingredient count matches the resolver',
    unmappedDb === unmappedExpected, `db ${unmappedDb}, expected ${unmappedExpected}`);

  const unmappedNoText = num((await one(sql`
    select count(*) as c from recipe_ingredients ri
    join catalog_recipes r on r.id = ri.recipe_id
    where r.source_name = ${SOURCE_NAME} and ri.food_id is null
      and (ri.display_text is null or ri.display_text = '')`)).c);
  check('unmapped ingredients still carry display_text', unmappedNoText === 0, `${unmappedNoText} blank`);

  // ---- H. taxonomy ------------------------------------------------------
  console.log('');
  console.log('H. TAXONOMY (load_taxonomy.js)');
  const tp = plan(payload.recipes);

  const roots = await all(sql`
    select slug, kind, parent_id from categories
    where slug in (${DISH_ROOT.slug}, ${CUISINE_ROOT.slug})`);
  check('both recipe roots exist, kind=recipe, no parent',
    roots.length === 2 && roots.every((r) => r.kind === 'recipe' && r.parent_id === null),
    JSON.stringify(roots));

  const dishRows = await all(sql`
    select c.slug from categories c join categories p on p.id = c.parent_id
    where p.slug = ${DISH_ROOT.slug}`);
  check(`dish-type tree holds ${tp.dishes.length} leaves`, dishRows.length === tp.dishes.length,
    `db ${dishRows.length}`);

  const cuisineRows = await all(sql`
    select c.slug from categories c join categories p on p.id = c.parent_id
    where p.slug = ${CUISINE_ROOT.slug}`);
  check(`cuisine tree holds ${tp.cuisines.length} leaves`, cuisineRows.length === tp.cuisines.length,
    `db ${cuisineRows.length}`);

  const ausnutCats = num((await one(sql`select count(*) as c from categories where kind = 'food'`)).c);
  check('AUSNUT food categories undisturbed (662)', ausnutCats === 662, `${ausnutCats}`);

  const linkCount = num((await one(sql`
    select count(*) as c from recipe_categories rc
    join catalog_recipes r on r.id = rc.recipe_id where r.source_name = ${SOURCE_NAME}`)).c);
  check(`recipe_categories = 2 per recipe (${tp.links.length})`, linkCount === tp.links.length,
    `db ${linkCount}`);

  const primaries = await all(sql`
    select count(*) filter (where rc.is_primary) as prim,
           count(distinct rc.recipe_id) filter (where rc.is_primary) as recipes_with_primary
    from recipe_categories rc join catalog_recipes r on r.id = rc.recipe_id
    where r.source_name = ${SOURCE_NAME}`);
  check('every recipe has exactly one primary category',
    num(primaries[0].prim) === payload.recipes.length
      && num(primaries[0].recipes_with_primary) === payload.recipes.length,
    JSON.stringify(primaries[0]));

  const primaryIsDish = num((await one(sql`
    select count(*) as c from recipe_categories rc
    join categories c on c.id = rc.category_id
    join categories p on p.id = c.parent_id
    join catalog_recipes r on r.id = rc.recipe_id
    where r.source_name = ${SOURCE_NAME} and rc.is_primary and p.slug <> ${DISH_ROOT.slug}`)).c);
  check('the primary is always a dish type, never a cuisine', primaryIsDish === 0, `${primaryIsDish} wrong`);

  // Re-derive one recipe's filing from the JSON and read it back.
  const sample = payload.recipes[0];
  const filed = await all(sql`
    select c.name, p.slug as tree, rc.is_primary
    from recipe_categories rc
    join categories c on c.id = rc.category_id
    join categories p on p.id = c.parent_id
    join catalog_recipes r on r.id = rc.recipe_id
    where r.source_name = ${SOURCE_NAME} and r.source_record_id = ${sample.source_record_id}
    order by rc.is_primary desc`);
  const dishOk = filed.find((f) => f.tree === DISH_ROOT.slug && f.is_primary)?.name === sample.category;
  const cuisineOk = filed.find((f) => f.tree === CUISINE_ROOT.slug && !f.is_primary)?.name === sample.area;
  check(`sample recipe is filed as ${sample.category} / ${sample.area}`, dishOk && cuisineOk,
    JSON.stringify(filed));

  const attrCount = num((await one(sql`
    select count(*) as c from recipe_attributes ra
    join catalog_recipes r on r.id = ra.recipe_id where r.source_name = ${SOURCE_NAME}`)).c);
  check(`recipe_attributes matches the plan (${tp.attrLinks.length})`, attrCount === tp.attrLinks.length,
    `db ${attrCount}`);

  const dietRows = await all(sql`
    select a.slug, count(*) as c, bool_and(ra.value = 1) as all_true
    from recipe_attributes ra join attributes a on a.id = ra.attribute_id
    join catalog_recipes r on r.id = ra.recipe_id
    where r.source_name = ${SOURCE_NAME} and a.kind = 'diet'
    group by a.slug order by a.slug`);
  const vegCount = payload.recipes.filter((r) => r.category === 'Vegetarian').length
    + payload.recipes.filter((r) => r.category === 'Vegan').length; // vegan implies vegetarian
  const veganCount = payload.recipes.filter((r) => r.category === 'Vegan').length;
  const vegRow = dietRows.find((d) => d.slug === 'vegetarian');
  const veganRow = dietRows.find((d) => d.slug === 'vegan');
  check(`diet flags: vegetarian ${vegCount} (incl. implied), vegan ${veganCount}, all value=1`,
    vegRow && num(vegRow.c) === vegCount && vegRow.all_true
      && veganRow && num(veganRow.c) === veganCount && veganRow.all_true,
    JSON.stringify(dietRows));

  const implied = num((await one(sql`
    select count(*) as c from recipe_attributes ra join attributes a on a.id = ra.attribute_id
    where a.slug = 'vegetarian' and ra.is_derived`)).c);
  check('implied vegetarian flags are marked is_derived', implied === veganCount, `${implied}`);

  const stated = num((await one(sql`
    select count(*) as c from recipe_attributes ra join attributes a on a.id = ra.attribute_id
    join catalog_recipes r on r.id = ra.recipe_id
    where r.source_name = ${SOURCE_NAME} and a.kind = 'tag' and ra.is_derived`)).c);
  check('every tag is marked as source-stated, not derived', stated === 0, `${stated} derived`);

  const desert = num((await one(sql`select count(*) as c from attributes where slug = 'tag-desert'`)).c);
  const dessert = num((await one(sql`select count(*) as c from attributes where slug = 'tag-dessert'`)).c);
  check('"Desert" typo was folded into "Dessert"', desert === 0 && dessert === 1);

  const discretionary = num((await one(sql`
    select count(*) as c from food_attributes`)).c);
  check('AUSNUT food_attributes undisturbed (3,741)', discretionary === 3741, `${discretionary}`);

  // Browse probe: recursive CTE from the Cuisine root, the same shape the
  // AUSNUT category tree is verified with.
  const browse = await all(sql`
    with recursive tree as (
      select id from categories where slug = ${CUISINE_ROOT.slug}
      union all
      select c.id from categories c join tree t on c.parent_id = t.id)
    select count(distinct rc.recipe_id) as c from recipe_categories rc
    where rc.category_id in (select id from tree)`);
  check('recursive browse from Cuisine root reaches every recipe',
    num(browse[0].c) === payload.recipes.length, `${browse[0].c}`);

  if (VERBOSE && problems.length) {
    console.log('');
    console.log('  problems:');
    for (const p of problems.slice(0, 40)) console.log(`    ${p}`);
  }

  console.log('');
  console.log('='.repeat(64));
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('='.repeat(64));
  if (failed) process.exitCode = 1;
} catch (err) {
  console.error('');
  console.error('VERIFY FAILED:', err && err.message ? err.message : err);
  let c = err && err.cause;
  while (c) { console.error('  caused by:', c.code || '', c.message || c); c = c.cause; }
  process.exitCode = 1;
} finally {
  await pool.end();
}
