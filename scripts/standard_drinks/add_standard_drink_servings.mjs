// Add a "1 standard drink" serving to every alcoholic catalogue food
// (checklist m3-05, task T7, 2026-11-21).
//
// DRY RUN BY DEFAULT: prints what it would do and writes nothing. Only
// `--write` changes the database. The laptop session runs it; the Pi has no
// .env and never runs it.
//
//   node scripts/standard_drinks/add_standard_drink_servings.mjs           (dry run)
//   node scripts/standard_drinks/add_standard_drink_servings.mjs --write
//
// For every ACTIVE food whose default serving's profile has alcohol_g > 0:
//   alcohol per gram    = default profile alcohol_g / default serving grams
//   standard-drink size = 10 g / that, rounded to 0.1 g
// With --write, in ONE transaction per food: a new nutrition profile (the
// default's, every nutrient scaled to the new size, alcohol_g = 10), a new
// serving "1 standard drink (about N ml)" pointing at it, and that serving
// made the default (the old default is unset first, because the partial
// unique index allows one default per food at any moment).
//
// Idempotent: a food that already has a serving starting "1 standard drink"
// is skipped. Note for later: re-running importers/ausnut/load.js resets every
// AUSNUT food's default to its first AUSNUT measure; the standard-drink
// serving stays, but is no longer the default, and this script will not
// re-default it (it skips foods that have one).

import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { and, eq, gt, inArray, like, sql } from "drizzle-orm";

import { ENV } from "../../src/config/env.js";
import { catalogFoodServingsTable as servingsT, catalogFoodsTable as foodsT, nutritionProfilesTable as profilesT } from "../../src/db/food_schema.js";
import {
  DESCRIPTION_PREFIX,
  isStandardDrinkCandidate,
  profileMatchesServing,
  standardDrinkProfile,
  standardDrinkServing,
  standardDrinkServingRow,
} from "./standardDrinks.js";

const WRITE = process.argv.includes("--write");

const pool = new Pool({ connectionString: ENV.DB_URL });
const db = drizzle(pool);

async function main() {
  console.log(`Standard-drink servings: ${WRITE ? "WRITE" : "DRY RUN (nothing is written)"}\n`);

  const rows = await db
    .select({
      foodId: foodsT.id,
      name: foodsT.name,
      servingId: servingsT.id,
      servingDescription: servingsT.description,
      grams: servingsT.gramsEquivalent,
      profileId: servingsT.nutritionProfileId,
      alcoholG: profilesT.alcoholG,
      basisQuantity: profilesT.basisQuantity,
      // Live review, 2026-11-21: the food's AUSNUT sub-group, so only drinks
      // get a standard-drink serving (isStandardDrinkCandidate).
      group: sql`(select grp.slug from food_categories fc
        join categories c on c.id = fc.category_id
        join categories grp on grp.id = c.parent_id
        where fc.food_id = ${foodsT.id} and fc.is_primary limit 1)`,
    })
    .from(foodsT)
    .innerJoin(servingsT, and(eq(servingsT.foodId, foodsT.id), eq(servingsT.isDefault, true)))
    .innerJoin(profilesT, eq(profilesT.id, servingsT.nutritionProfileId))
    .where(and(eq(foodsT.isActive, true), gt(profilesT.alcoholG, 0)))
    .orderBy(foodsT.name);

  const already = rows.length === 0 ? [] : await db
    .selectDistinct({ foodId: servingsT.foodId })
    .from(servingsT)
    .where(and(inArray(servingsT.foodId, rows.map((r) => r.foodId)), like(servingsT.description, `${DESCRIPTION_PREFIX}%`)));
  const hasOne = new Set(already.map((r) => r.foodId));

  const plan = [];
  const skipped = [];
  const notDrinks = [];
  for (const row of rows) {
    if (!isStandardDrinkCandidate(row)) {
      notDrinks.push(row.name);
      continue;
    }
    if (hasOne.has(row.foodId)) {
      skipped.push(`${row.name}: already has a standard-drink serving`);
      continue;
    }
    if (!profileMatchesServing(row.basisQuantity, row.grams)) {
      skipped.push(`${row.name}: profile basis ${row.basisQuantity} g is not the serving's ${row.grams} g, so not guessed`);
      continue;
    }
    const serving = standardDrinkServing({ alcoholG: row.alcoholG, grams: row.grams });
    if (!serving) {
      skipped.push(`${row.name}: no usable grams or alcohol`);
      continue;
    }
    plan.push({ row, serving });
  }

  console.log("  food | current default | its standard drinks | new serving");
  for (const { row, serving } of plan) {
    console.log(`  ${row.name} | ${row.servingDescription} (${row.grams} g) | ${serving.defaultStandardDrinks} | ${serving.description}, ${serving.grams} g`);
  }
  console.log(`\n  ${plan.length} of ${rows.length} foods with alcohol get a standard-drink serving.`);
  console.log(`  ${notDrinks.length} are not drinks (dishes, sauces, desserts, cooking wine, de-alcoholised) and keep their serving as it is.`);
  if (skipped.length) {
    console.log(`  ${skipped.length} skipped:`);
    for (const line of skipped) console.log(`    ${line}`);
  }

  if (!WRITE) {
    console.log("\n  DRY RUN: nothing written. Re-run with --write to add these.");
    return;
  }

  let written = 0;
  for (const { row, serving } of plan) {
    await db.transaction(async (tx) => {
      const [profile] = await tx.select().from(profilesT).where(eq(profilesT.id, row.profileId));
      const newProfile = standardDrinkProfile(profile, serving.grams, row.grams);
      if (!newProfile) throw new Error(`${row.name}: could not copy profile ${row.profileId}`);
      const [{ id: nutritionProfileId }] = await tx.insert(profilesT).values(newProfile).returning({ id: profilesT.id });
      const [{ maxOrder }] = await tx
        .select({ maxOrder: sql`coalesce(max(${servingsT.sortOrder}), 0)`.mapWith(Number) })
        .from(servingsT)
        .where(eq(servingsT.foodId, row.foodId));
      // The partial unique index allows one default per food at any moment:
      // clear the old default before the new serving claims it.
      await tx
        .update(servingsT)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(servingsT.foodId, row.foodId), eq(servingsT.isDefault, true)));
      await tx.insert(servingsT).values(standardDrinkServingRow({
        foodId: row.foodId, nutritionProfileId, serving, sortOrder: maxOrder + 1,
      }));
    });
    written += 1;
  }
  console.log(`\n  Wrote ${written} standard-drink servings, one transaction per food.`);
  console.log("  The planner pool caches servings: restart the backend to see them.");
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[standard_drinks] FAILED (the failing food's transaction rolled back):", err);
    await pool.end();
    process.exit(1);
  });
