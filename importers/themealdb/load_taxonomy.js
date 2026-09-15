/**
 * TheMealDB recipe import: taxonomy seed. Kept SEPARATE from load.js on
 * purpose, exactly as load_categories.js is for AUSNUT: a taxonomy is not
 * nutrition data, it can be re-seeded without touching a recipe or a nutrient
 * row, and load.js stays proven and unmodified.
 *
 * Reads tools/themealdb_extract/out/themealdb.json and writes:
 *   categories          two trees under kind='recipe':
 *                         Dish type  -> the 14 strCategory values
 *                         Cuisine    -> the 29 curated strArea values
 *   recipe_categories   dish type PRIMARY, cuisine non-primary
 *   attributes          kind='diet' vegetarian + vegan; kind='tag' per strTags
 *   recipe_attributes   diet flags and tags, is_derived=false (stated by source)
 *
 * Decisions taken with the user 2026-09-10, recorded here so nobody re-derives them:
 *
 *   CUISINE IS A CATEGORY TREE, NOT A TAG. It is a closed 29-value
 *   classification you browse, not a yes/no facet, and attributes.kind has no
 *   cuisine slot; forcing it into 'tag' would file "Thai" next to "HangoverFood".
 *   A recipe therefore carries TWO category links, and the partial unique index
 *   recipe_categories_one_primary is what keeps dish type the only primary.
 *
 *   VEGETARIAN AND VEGAN ARE BOTH A CATEGORY AND A DIET ATTRIBUTE. TheMealDB
 *   files them as categories, so those 76 recipes have no other dish type and
 *   must keep the category to have a primary at all. But they ARE diets, and
 *   attributes.kind='diet' exists for precisely this, so the flag is written
 *   too. Two facts that mean different things: where it is filed vs what diet
 *   it fits. A Vegan recipe additionally gets vegetarian=1 with is_derived=true,
 *   because that one is an inference, not a source statement.
 *
 *   ALL 75 TAGS ARE SEEDED, with one fold: "Desert" (9 uses) is an unambiguous
 *   source typo for "Dessert" and is merged. Singletons are kept; dropping them
 *   would be a threshold chosen for neatness, not a measured reason.
 *
 *   node importers/themealdb/load_taxonomy.js --dry-run    (from backend/)
 *   node importers/themealdb/load_taxonomy.js
 *
 * MUST be run from backend/ - dotenv resolves .env from process.cwd().
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';

import { ENV } from '../../src/config/env.js';
import { SOURCE_NAME } from './load.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IN_RECIPES = path.resolve(HERE, '../../../tools/themealdb_extract/out/themealdb.json');

export const DISH_ROOT = { slug: 'themealdb-dish-type', name: 'Dish type' };
export const CUISINE_ROOT = { slug: 'themealdb-cuisine', name: 'Cuisine' };

// Source typos folded on the way in. Keep this list tiny and obvious; anything
// arguable belongs in a review, not here.
export const TAG_FOLDS = { Desert: 'Dessert' };

// Categories TheMealDB uses that are really diets. The category row is still
// created (see header); this is what ALSO earns a diet attribute.
export const DIET_CATEGORIES = { Vegetarian: 'vegetarian', Vegan: 'vegan' };

export const slugify = (s) => String(s).toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const dishSlug = (name) => `themealdb-dish-${slugify(name)}`;
export const cuisineSlug = (name) => `themealdb-cuisine-${slugify(name)}`;
export const tagSlug = (name) => `tag-${slugify(name)}`;

/**
 * Pure planning step: turn the recipe list into the exact rows to write.
 * Exported so it can be asserted on without a database.
 */
export const plan = (recipes) => {
  const dishCounts = new Map();
  const cuisineCounts = new Map();
  const tagCounts = new Map();
  for (const r of recipes) {
    dishCounts.set(r.category, (dishCounts.get(r.category) ?? 0) + 1);
    cuisineCounts.set(r.area, (cuisineCounts.get(r.area) ?? 0) + 1);
    for (const raw of r.tags ?? []) {
      const t = TAG_FOLDS[raw] ?? raw;
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  // sort_order by frequency, most common first, so a browse surface leads
  // with Dessert / Vegetarian / Seafood rather than Goat.
  const byFreq = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const dishes = byFreq(dishCounts).map(([name, count], i) => ({
    slug: dishSlug(name), name, count, sort_order: i + 1,
  }));
  const cuisines = byFreq(cuisineCounts).map(([name, count], i) => ({
    slug: cuisineSlug(name), name, count, sort_order: i + 1,
  }));
  const tags = byFreq(tagCounts).map(([name, count]) => ({ slug: tagSlug(name), name, count }));

  const diets = Object.values(DIET_CATEGORIES).map((slug) => ({
    slug, name: slug.charAt(0).toUpperCase() + slug.slice(1),
  }));

  const links = [];
  for (const r of recipes) {
    links.push({ recipe: r.source_record_id, category_slug: dishSlug(r.category), is_primary: true });
    links.push({ recipe: r.source_record_id, category_slug: cuisineSlug(r.area), is_primary: false });
  }

  const attrLinks = [];
  for (const r of recipes) {
    const diet = DIET_CATEGORIES[r.category];
    if (diet) {
      attrLinks.push({ recipe: r.source_record_id, attribute_slug: diet, value: 1,
        is_derived: false, evidence: `strCategory = ${r.category}` });
      if (diet === 'vegan') {
        attrLinks.push({ recipe: r.source_record_id, attribute_slug: 'vegetarian', value: 1,
          is_derived: true, evidence: 'implied by strCategory = Vegan' });
      }
    }
    const seen = new Set();
    for (const raw of r.tags ?? []) {
      const t = TAG_FOLDS[raw] ?? raw;
      const slug = tagSlug(t);
      if (seen.has(slug)) continue;
      seen.add(slug);
      attrLinks.push({ recipe: r.source_record_id, attribute_slug: slug, value: 1,
        is_derived: false, evidence: raw === t ? 'strTags' : `strTags (folded from "${raw}")` });
    }
  }

  return { dishes, cuisines, tags, diets, links, attrLinks };
};

async function main() {
  const DRY = process.argv.includes('--dry-run');
  const pool = new Pool({ connectionString: ENV.DB_URL });
  const db = drizzle(pool);

  try {
    const payload = JSON.parse(readFileSync(IN_RECIPES, 'utf-8'));
    const p = plan(payload.recipes);
    console.log(`${DRY ? 'DRY RUN: ' : ''}seeding taxonomy for ${payload.recipes.length} recipes`);
    console.log(`  dish types ${p.dishes.length}, cuisines ${p.cuisines.length},`
      + ` tags ${p.tags.length}, diets ${p.diets.length}`);
    console.log(`  recipe_categories ${p.links.length}, recipe_attributes ${p.attrLinks.length}`);

    await db.transaction(async (tx) => {
      const all = async (q) => { const r = await tx.execute(q); return r.rows ?? r; };

      // Categories are upserted by slug and NEVER deleted: parent_id and the
      // link tables are ON DELETE RESTRICT, so a delete would either fail or
      // orphan a subtree. Slug is the identity.
      const upsertCategory = async (c, parentId) => {
        const rows = await all(sql`
          insert into categories (parent_id, kind, name, slug, sort_order)
          values (${parentId}, 'recipe', ${c.name}, ${c.slug}, ${c.sort_order ?? 0})
          on conflict (slug) do update set
            parent_id = excluded.parent_id, name = excluded.name,
            sort_order = excluded.sort_order, updated_at = now()
          returning id`);
        return Number(rows[0].id);
      };

      // Roots first: parent_id is RESTRICT, so a parent must exist before a child.
      const dishRootId = await upsertCategory({ ...DISH_ROOT, sort_order: 1 }, null);
      const cuisineRootId = await upsertCategory({ ...CUISINE_ROOT, sort_order: 2 }, null);
      const catId = new Map();
      for (const d of p.dishes) catId.set(d.slug, await upsertCategory(d, dishRootId));
      for (const c of p.cuisines) catId.set(c.slug, await upsertCategory(c, cuisineRootId));

      const upsertAttribute = async (a, kind) => {
        const rows = await all(sql`
          insert into attributes (kind, name, slug)
          values (${kind}, ${a.name}, ${a.slug})
          on conflict (slug) do update set name = excluded.name, updated_at = now()
          returning id`);
        return Number(rows[0].id);
      };
      const attrId = new Map();
      for (const d of p.diets) attrId.set(d.slug, await upsertAttribute(d, 'diet'));
      for (const t of p.tags) attrId.set(t.slug, await upsertAttribute(t, 'tag'));

      const recipeRows = await all(sql`
        select id, source_record_id from catalog_recipes where source_name = ${SOURCE_NAME}`);
      const recipeId = new Map(recipeRows.map((r) => [r.source_record_id, Number(r.id)]));
      const missing = p.links.filter((l) => !recipeId.has(l.recipe)).length;
      if (missing) throw new Error(`${missing} links reference recipes not in catalog_recipes; run load.js first`);

      // Links are replaced wholesale for this source's recipes. They are pure
      // derivations of the JSON with no identity worth preserving.
      await tx.execute(sql`
        delete from recipe_categories where recipe_id in
          (select id from catalog_recipes where source_name = ${SOURCE_NAME})`);
      await tx.execute(sql`
        delete from recipe_attributes where recipe_id in
          (select id from catalog_recipes where source_name = ${SOURCE_NAME})`);

      const CHUNK = 500;
      for (let i = 0; i < p.links.length; i += CHUNK) {
        const vals = p.links.slice(i, i + CHUNK).map((l) => sql`(${recipeId.get(l.recipe)},
          ${catId.get(l.category_slug)}, ${l.is_primary})`);
        await tx.execute(sql`
          insert into recipe_categories (recipe_id, category_id, is_primary)
          values ${sql.join(vals, sql`, `)}`);
      }
      for (let i = 0; i < p.attrLinks.length; i += CHUNK) {
        const vals = p.attrLinks.slice(i, i + CHUNK).map((l) => sql`(${recipeId.get(l.recipe)},
          ${attrId.get(l.attribute_slug)}, ${l.value}, null, ${l.is_derived}, ${l.evidence})`);
        await tx.execute(sql`
          insert into recipe_attributes (recipe_id, attribute_id, value, presence, is_derived, evidence)
          values ${sql.join(vals, sql`, `)}`);
      }

      if (DRY) throw new DryRunRollback();
    }).catch((e) => { if (!(e instanceof DryRunRollback)) throw e; });

    console.log('');
    console.log(DRY ? '  DRY RUN - rolled back, nothing was written.' : '  done.');
  } catch (err) {
    console.error('');
    console.error('TAXONOMY LOAD FAILED:', err && err.message ? err.message : err);
    let c = err && err.cause;
    while (c) { console.error('  caused by:', c.code || '', c.message || c); c = c.cause; }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

class DryRunRollback extends Error {}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
