/**
 * Seeds the AUSNUT classification tree into `categories`, links every AUSNUT
 * food to its leaf via `food_categories`, and records the Australian Dietary
 * Guidelines discretionary flag in `attributes` / `food_attributes`.
 * Checklist p2-23.
 *
 * Kept separate from load.js because a taxonomy is not food data: it can be
 * re-seeded without touching a single nutrition row, and load.js stays the
 * proven, unmodified importer.
 *
 *   node importers/ausnut/load_categories.js --dry-run
 *   node importers/ausnut/load_categories.js
 *
 * Idempotent: categories upsert on slug, links on their composite primary keys.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { eq, sql } from 'drizzle-orm';

import { ENV } from '../../src/config/env.js';
import {
  attributesTable,
  catalogFoodsTable,
  categoriesTable,
  foodAttributesTable,
  foodCategoriesTable,
} from '../../src/db/food_schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.resolve(HERE, '../../../tools/ausnut_extract/out/ausnut.json');

const SOURCE = 'ausnut_2023';
const DISCRETIONARY_SLUG = 'discretionary-food';

class Rollback extends Error {}

/**
 * A food is linked to its LEAF category only. Ancestors are reachable through
 * categories.parent_id, so storing them again would be denormalised data that
 * has to be rebuilt whenever the tree changes. See verify.js for the recursive
 * CTE that walks it.
 */
async function seedCategories(tx, categories, report) {
  // Level order matters: a parent row must exist before its children can
  // reference it, and parent_id is ON DELETE RESTRICT.
  const idByCode = new Map();
  for (const level of [1, 2, 3]) {
    const rows = categories.filter((c) => c.level === level);
    for (let i = 0; i < rows.length; i += 500) {
      const inserted = await tx
        .insert(categoriesTable)
        .values(rows.slice(i, i + 500).map((c) => ({
          parentId: c.parent_code ? idByCode.get(c.parent_code) : null,
          kind: 'food',
          name: c.name,
          slug: c.slug,
          // The AUSNUT code sorts groups in the order the survey publishes
          // them, which is more meaningful than alphabetical.
          sortOrder: Number(c.code),
          updatedAt: new Date(),
        })))
        .onConflictDoUpdate({
          target: categoriesTable.slug,
          set: {
            name: sql`excluded.name`,
            parentId: sql`excluded.parent_id`,
            sortOrder: sql`excluded.sort_order`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: categoriesTable.id, slug: categoriesTable.slug });
      for (const r of inserted) idByCode.set(r.slug.replace(/^ausnut-/, ''), r.id);
    }
    report.categories[level] = rows.length;
  }
  return idByCode;
}

async function seedDiscretionaryAttribute(tx) {
  const [row] = await tx
    .insert(attributesTable)
    .values({
      kind: 'tag',
      name: 'Discretionary food',
      slug: DISCRETIONARY_SLUG,
      description: 'Australian Dietary Guidelines: foods not needed to meet '
        + 'nutrient requirements, higher in saturated fat, added sugars, salt or alcohol.',
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: attributesTable.slug,
      set: { name: sql`excluded.name`, description: sql`excluded.description`, updatedAt: sql`now()` },
    })
    .returning({ id: attributesTable.id });
  return row.id;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const payload = JSON.parse(readFileSync(JSON_PATH, 'utf-8'));
  if (!payload.categories?.length) {
    throw new Error('ausnut.json has no categories - re-run tools/ausnut_extract/extract.py');
  }

  const byCode = new Map(payload.categories.map((c) => [c.code, c]));
  const leaves = new Set(payload.categories.filter((c) => c.level === 3).map((c) => c.code));
  const bad = payload.foods.filter((f) => !leaves.has(f.category_code));
  if (bad.length) {
    throw new Error(`${bad.length} food(s) reference a non-leaf category, e.g. ${bad[0].source_record_id}`);
  }

  console.log(`Seeding ${payload.categories.length} categories from ${path.basename(JSON_PATH)}`);
  console.log(`  ${payload.foods.length.toLocaleString()} foods to link, `
    + `${leaves.size} leaves (${new Set(payload.foods.map((f) => f.category_code)).size} in use)`);
  if (dryRun) console.log('  DRY RUN - rolled back at the end\n');

  const report = { categories: {}, links: 0, attributes: 0 };
  const pool = new Pool({ connectionString: ENV.DB_URL });
  const db = drizzle(pool);
  const started = Date.now();

  try {
    await db.transaction(async (tx) => {
      const idByCode = await seedCategories(tx, payload.categories, report);
      const attributeId = await seedDiscretionaryAttribute(tx);

      // Resolve AUSNUT source ids to catalog_foods ids in one query rather than
      // 3,741 round trips.
      const foods = await tx
        .select({ id: catalogFoodsTable.id, sourceRecordId: catalogFoodsTable.sourceRecordId })
        .from(catalogFoodsTable)
        .where(eq(catalogFoodsTable.sourceName, SOURCE));
      const foodIdBySource = new Map(foods.map((f) => [f.sourceRecordId, f.id]));
      console.log(`  resolved ${foodIdBySource.size.toLocaleString()} AUSNUT foods in the database`);

      const links = [];
      const attributes = [];
      for (const food of payload.foods) {
        const foodId = foodIdBySource.get(food.source_record_id);
        if (foodId === undefined) continue;   // food not imported yet
        links.push({
          foodId,
          categoryId: idByCode.get(food.category_code),
          isPrimary: true,
        });
        attributes.push({
          foodId,
          attributeId,
          value: food.discretionary,
          // presence is for allergens (contains / may_contain / free) and does
          // not apply to a dietary tag.
          presence: null,
          evidence: 'AUSNUT 2023 Discretionary food classification',
          sourceName: SOURCE,
        });
      }

      for (let i = 0; i < links.length; i += 1000) {
        await tx.insert(foodCategoriesTable).values(links.slice(i, i + 1000))
          .onConflictDoUpdate({
            target: [foodCategoriesTable.foodId, foodCategoriesTable.categoryId],
            set: { isPrimary: sql`excluded.is_primary` },
          });
        report.links += Math.min(1000, links.length - i);
      }
      for (let i = 0; i < attributes.length; i += 1000) {
        await tx.insert(foodAttributesTable).values(attributes.slice(i, i + 1000))
          .onConflictDoUpdate({
            target: [foodAttributesTable.foodId, foodAttributesTable.attributeId],
            set: { value: sql`excluded.value`, evidence: sql`excluded.evidence` },
          });
        report.attributes += Math.min(1000, attributes.length - i);
      }

      if (dryRun) throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) {
      console.error(`\nFAILED - rolled back, nothing was written.\n${e.message}`);
      await pool.end();
      process.exit(1);
    }
  }

  console.log(`\nReport (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(`  categories seeded : ${report.categories[1]} groups / `
    + `${report.categories[2]} sub-groups / ${report.categories[3]} categories`);
  console.log(`  food_categories   : ${report.links.toLocaleString()}`);
  console.log(`  food_attributes   : ${report.attributes.toLocaleString()}`);

  if (!dryRun) {
    const c = await db.execute(sql`
      select (select count(*)::int from categories)                        as categories,
             (select count(*)::int from food_categories)                   as links,
             (select count(*)::int from attributes)                        as attributes,
             (select count(*)::int from food_attributes)                   as food_attributes,
             (select count(*)::int from food_categories where is_primary)  as primaries`);
    console.log('\nIn the database now:', JSON.stringify(c.rows[0]));
  } else {
    console.log('\nRolled back - nothing was written.');
  }
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
