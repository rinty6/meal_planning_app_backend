// This schema store food and recipe data for our meal app

import { pgTable, bigint, text, timestamp, boolean, numeric, uniqueIndex, check, index, integer, smallint, primaryKey, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Reusable shape for the 24 nutrient columns: all nullable, because unknown is
// NOT zero. mode:'number' is essential — without it Drizzle hands back strings.
const nutrient = (col) => numeric(col, {precision: 12, scale: 4, mode: 'number'});

// This table store names of branded food items
// There is no 2 same row value for food names 
export const catalogBrandsTable = pgTable('catalog_brands', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull(),
  websiteUrl: text('website_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  nameUniqueIdx: uniqueIndex('catalog_brands_name_unique').on(table.name),
  normalizedNameUniqueIdx: uniqueIndex('catalog_brands_normalized_name_unique').on(table.normalizedName),
}));

// This table contains nutrition details
// This nutrition tables has 1:1 relationship with catalog_food_serving
// It also has 1:1 relationship with recipe table

export const nutritionProfilesTable = pgTable('nutrition_profiles', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),

  // What "one unit" of this profile means. basis_state matters because AUSNUT is
  // per 100g EDIBLE PORTION while Open Food Facts is per 100g AS SOLD — same
  // numbers, different physical thing for anything with peel, bone or shell.
  basisQuantity: numeric('basis_quantity', { precision: 12, scale: 4, mode: 'number' }).notNull(),
  basisUnit: text('basis_unit').notNull(),
  basisState: text('basis_state').notNull(),

  // energy_kj sits alongside kcal because AU labels are legally kJ and AUSNUT
  // has no kcal column at all.
  caloriesKcal: nutrient('calories_kcal'),
  energyKj: nutrient('energy_kj'),

  proteinG: nutrient('protein_g'),
  carbohydrateG: nutrient('carbohydrate_g'),
  // AUSNUT carbohydrate EXCLUDES fibre, USDA's includes it. Not interchangeable.
  carbohydrateBasis: text('carbohydrate_basis').notNull(),
  fatG: nutrient('fat_g'),
  saturatedFatG: nutrient('saturated_fat_g'),
  transFatG: nutrient('trans_fat_g'),
  polyunsaturatedFatG: nutrient('polyunsaturated_fat_g'),
  monounsaturatedFatG: nutrient('monounsaturated_fat_g'),
  cholesterolMg: nutrient('cholesterol_mg'),
  sodiumMg: nutrient('sodium_mg'),
  potassiumMg: nutrient('potassium_mg'),
  fiberG: nutrient('fiber_g'),
  sugarG: nutrient('sugar_g'),
  addedSugarsG: nutrient('added_sugars_g'),
  vitaminDMcg: nutrient('vitamin_d_mcg'),
  calciumMg: nutrient('calcium_mg'),
  ironMg: nutrient('iron_mg'),

  // AUSNUT reports retinol equivalents (beta-carotene ÷6), USDA reports RAE
  // (÷12), OFF states neither — so the convention travels with the value.
  vitaminAMcg: nutrient('vitamin_a_mcg'),
  vitaminAConvention: text('vitamin_a_convention'),
  vitaminCMg: nutrient('vitamin_c_mg'),

  // Grams of pure alcohol per basis quantity. AUSNUT publishes it as
  // "Alcohol (g)" and it was simply never imported.
  //
  // It is how a standard drink becomes exact rather than estimated:
  // Australia defines one standard drink as 10 g of pure alcohol whatever the
  // drink, so standard_drinks = alcohol_g * grams / 100 / 10, with no alc/vol
  // table and no ethanol-density assumption.
  //
  // This does NOT change the energy figures. AUSNUT's energy already includes
  // alcohol at 29 kJ/g, so there is no double count to correct.
  alcoholG: nutrient('alcohol_g'),

  calculationMethod: text('calculation_method').notNull(),
  confidence: numeric('confidence', { precision: 5, scale: 4, mode: 'number' }),

  sourceName: text('source_name').notNull(),
  sourceLicense: text('source_license').notNull(),
  // How the source measured it: analysed (lab) > label_data > recipe > imputed
  // > borrowed > estimated. NULL for USDA/OFF, which publish no equivalent.
  sourceDerivation: text('source_derivation'),

  calculatedAt: timestamp('calculated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  basisStateCheck: check('nutrition_profiles_basis_state_check',
    sql`${table.basisState} IN ('as_sold','edible_portion','prepared')`),

  carbohydrateBasisCheck: check('nutrition_profiles_carbohydrate_basis_check',
    sql`${table.carbohydrateBasis} IN ('by_difference','available')`),

  vitaminAConventionCheck: check('nutrition_profiles_vitamin_a_convention_check',
    sql`${table.vitaminAConvention} IS NULL OR ${table.vitaminAConvention} IN ('rae','re')`),

  calculationMethodCheck: check('nutrition_profiles_calculation_method_check',
    sql`${table.calculationMethod} IN ('lab','label','ingredient_calculation','manual','scaled_from_per_100g')`),

  sourceDerivationCheck: check('nutrition_profiles_source_derivation_check',
    sql`${table.sourceDerivation} IS NULL OR ${table.sourceDerivation} IN
        ('analysed','label_data','recipe','borrowed','imputed','estimated','unknown')`),

  confidenceCheck: check('nutrition_profiles_confidence_check',
    sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`),

  // LEAST() ignores NULLs and returns NULL only when every argument is NULL, and
  // a CHECK passes on NULL — so this enforces ">= 0 for every populated
  // nutrient" in one line instead of 24 separate IS NULL OR ... clauses.
  nutrientsNonNegative: check('nutrition_profiles_nutrients_non_negative',
    sql`LEAST(
      ${table.caloriesKcal}, ${table.energyKj}, ${table.proteinG}, ${table.carbohydrateG},
      ${table.fatG}, ${table.saturatedFatG}, ${table.transFatG}, ${table.polyunsaturatedFatG},
      ${table.monounsaturatedFatG}, ${table.cholesterolMg}, ${table.sodiumMg}, ${table.potassiumMg},
      ${table.fiberG}, ${table.sugarG}, ${table.addedSugarsG}, ${table.vitaminDMcg},
      ${table.calciumMg}, ${table.ironMg}, ${table.vitaminAMcg}, ${table.vitaminCMg},
      ${table.basisQuantity}
    ) >= 0`),
}));


// This table contain food detail, including generic and branded food items
// One food identity. Nutrition NEVER lives on this row — it hangs off
// catalog_food_servings, so a food can expose many servings without
// duplicating or guessing which one is "the" serving.
export const catalogFoodsTable = pgTable('catalog_foods', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),

  // Typed public id ('food_...'), so an id can never be mistaken for a recipe id.
  publicId: text('public_id').notNull(),

  // Nullable: generic AUSNUT/USDA foods have no brand.
  brandId: bigint('brand_id', { mode: 'number' }).references(() => catalogBrandsTable.id),

  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull(),

  // AUSNUT names are comma-separated survey clauses: "Beer, full strength
  // (alcohol 4-4.9% v/v), low carbohydrate". base_name groups them ("beer",
  // 702 distinct values); name_segments holds the clauses as an ORDERED ARRAY
  // so @> ARRAY['commercial'] matches regardless of position — 18% of the
  // 1,726-segment vocabulary appears at more than one position.
  baseName: text('base_name'),
  nameSegments: text('name_segments').array(),

  description: text('description'),
  foodType: text('food_type').notNull(),

  barcode: text('barcode'),
  barcodeType: text('barcode_type'),
  primaryImageUrl: text('primary_image_url'),

  region: text('region').notNull(),
  language: text('language').notNull(),

  sourceName: text('source_name').notNull(),
  sourceRecordId: text('source_record_id'),
  sourceLicense: text('source_license').notNull(),

  verificationStatus: text('verification_status').notNull(),
  isActive: boolean('is_active').default(true).notNull(),

  // Can this food be put on a meal card as itself?
  //
  //   servable    eaten or drunk as itself. Cooked rice, miso paste, an apple,
  //               a raw salad, red wine.
  //   component   edible and real, but only ever part of something else. Oil,
  //               tomato paste, gravy, salad dressing. Valid inside a recipe,
  //               valid to log and to cost, never a standalone card.
  //   ingredient  not consumable as served. Flour, dry gravy powder, uncooked
  //               pasta, raw mince, stock cubes. Never shown in planning.
  //   NULL        not classified. Only the 3,741 generic foods are; the
  //               46,002 branded ones are not. A planner query asking for
  //               `= 'servable'` therefore excludes them, which is correct and
  //               is the same fail-closed shape as the allergen filter.
  //
  // A column rather than a satellite table because, unlike a price, this is an
  // intrinsic and stable property of the food, like food_type, and the planner
  // filters on it on every request. Written only by tools/food_classify.
  servability: text('servability'),
  servabilityReason: text('servability_reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  publicIdUnique: uniqueIndex('catalog_foods_public_id_unique').on(table.publicId),

  servabilityCheck: check('catalog_foods_servability_check',
    sql`${table.servability} IS NULL
        OR ${table.servability} IN ('servable', 'component', 'ingredient')`),

  // The planner's hottest predicate: every candidate query starts by asking
  // for servable generic foods.
  servabilityIdx: index('catalog_foods_servability_idx')
    .on(table.servability).where(sql`${table.servability} = 'servable'`),
  publicIdCheck: check('catalog_foods_public_id_check',
    sql`${table.publicId} LIKE 'food\\_%'`),

  // Makes every importer idempotent: re-running an import upserts instead of
  // duplicating. Required by checklist p2-24.
  sourceRecordUnique: uniqueIndex('catalog_foods_source_record_unique')
    .on(table.sourceName, table.sourceRecordId),

  // Scoped to region, NOT global: the same barcode legitimately appears in
  // multiple regions and from multiple sources. Partial, because most generic
  // foods have no barcode and NULLs must not collide.
  barcodeRegionUnique: uniqueIndex('catalog_foods_barcode_region_unique')
    .on(table.barcode, table.region)
    .where(sql`${table.barcode} IS NOT NULL`),

  // Position-independent segment filtering: name_segments @> ARRAY['commercial']
  segmentsGin: index('catalog_foods_name_segments_gin')
    .using('gin', table.nameSegments),

  // Fuzzy search. REQUIRES the pg_trgm extension — see the note below.
  nameTrgm: index('catalog_foods_normalized_name_trgm')
    .using('gin', table.normalizedName.op('gin_trgm_ops')),

  baseNameIdx: index('catalog_foods_base_name_idx').on(table.baseName),
  brandIdIdx: index('catalog_foods_brand_id_idx').on(table.brandId),
}));


// This table contains serving unit of each food item
// A food item has 1:N relationship with serving unit table
// For example, a banana has many servng units: 100g, medium size,..
export const catalogFoodServingsTable = pgTable('catalog_food_servings', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),

  foodId: bigint('food_id', { mode: 'number' })
    .references(() => catalogFoodsTable.id, { onDelete: 'cascade' }).notNull(),

  // 1:1 — a profile belongs to exactly one serving, enforced by the unique index.
  nutritionProfileId: bigint('nutrition_profile_id', { mode: 'number' })
    .references(() => nutritionProfilesTable.id).notNull(),

  description: text('description').notNull(),
  numberOfUnits: numeric('number_of_units', { precision: 12, scale: 4, mode: 'number' }).notNull(),
  measurementDescription: text('measurement_description').notNull(),

  // The source's own id for this serving (AUSNUT's Measure ID, globally unique
  // across its 9,816 rows). Without it a re-import cannot match existing rows
  // and has to delete-and-reinsert, churning ids. Nullable: servings we
  // synthesise ourselves (the 100 g default for a food AUSNUT gives no measure
  // for) have no upstream id.
  sourceRecordId: text('source_record_id'),

  metricAmount: numeric('metric_amount', { precision: 12, scale: 4, mode: 'number' }),
  metricUnit: text('metric_unit'),
  gramsEquivalent: numeric('grams_equivalent', { precision: 12, scale: 4, mode: 'number' }),
  millilitresEquivalent: numeric('millilitres_equivalent', { precision: 12, scale: 4, mode: 'number' }),

  isDefault: boolean('is_default').default(false).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  profileUnique: uniqueIndex('catalog_food_servings_profile_unique').on(table.nutritionProfileId),

  // THE fix for pickBestServing: at most one default per food, enforced by the
  // database rather than guessed from calorie values at query time.
  oneDefaultPerFood: uniqueIndex('catalog_food_servings_one_default')
    .on(table.foodId).where(sql`${table.isDefault}`),

  // Target for the composite FK on recipe_ingredients, which stops an
  // ingredient pointing at ANOTHER food's serving row.
  idFoodUnique: uniqueIndex('catalog_food_servings_id_food_unique').on(table.id, table.foodId),

  // Scoped to the food, not global: a food belongs to one source, so this stays
  // safe once USDA and OFF servings land alongside AUSNUT's. Postgres treats
  // NULLs as distinct, so synthesised servings never collide here.
  sourceRecordUnique: uniqueIndex('catalog_food_servings_source_record_unique')
    .on(table.foodId, table.sourceRecordId),

  metricUnitCheck: check('catalog_food_servings_metric_unit_check',
    sql`${table.metricUnit} IS NULL OR ${table.metricUnit} IN ('g','ml','oz')`),

  foodIdIdx: index('catalog_food_servings_food_id_idx').on(table.foodId),
}));

// Hierarchical classification, shared by foods and recipes. Self-referencing
// via parent_id: AUSNUT's 3-level system (24 groups / 133 sub-groups / 505
// categories) maps directly onto this without a fixed depth limit.
export const categoriesTable = pgTable('categories', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),

  // NULL = top-level. onDelete restrict, because silently orphaning or
  // cascading away a whole subtree of categories is never what you want.
  parentId: bigint('parent_id', { mode: 'number' })
    .references(() => categoriesTable.id, { onDelete: 'restrict' }),

  kind: text('kind').notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  sortOrder: integer('sort_order').default(0).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  slugUnique: uniqueIndex('categories_slug_unique').on(table.slug),
  kindCheck: check('categories_kind_check',
    sql`${table.kind} IN ('food','recipe','shared')`),
  parentIdIdx: index('categories_parent_id_idx').on(table.parentId),
}));

// Allergens, diet classifications and searchable tags. This is where the
// characteristic-segment vocabulary from the AUSNUT name split eventually
// lands (p3-09): 'raw', 'commercial', 'homemade' etc. get promoted from
// name_segments into real facets so filters work across Open Food Facts and
// USDA foods too, not only AUSNUT ones.
export const attributesTable = pgTable('attributes', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  slugUnique: uniqueIndex('attributes_slug_unique').on(table.slug),
  kindCheck: check('attributes_kind_check',
    sql`${table.kind} IN ('allergen','diet','tag')`),
}));


// Many-to-many: foods <-> categories. Composite PK means a food can't be
// filed under the same category twice, with no surrogate id to maintain.
export const foodCategoriesTable = pgTable('food_categories', {
  foodId: bigint('food_id', { mode: 'number' })
    .references(() => catalogFoodsTable.id, { onDelete: 'cascade' }).notNull(),
  categoryId: bigint('category_id', { mode: 'number' })
    .references(() => categoriesTable.id, { onDelete: 'restrict' }).notNull(),
  isPrimary: boolean('is_primary').default(false).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.foodId, table.categoryId] }),

  // Same reasoning as one-default-serving: "the" category of a food should be
  // a fact the database enforces, not something the app picks at query time.
  // NOTE: this is an addition beyond the schema doc — see the note below.
  onePrimaryPerFood: uniqueIndex('food_categories_one_primary')
    .on(table.foodId).where(sql`${table.isPrimary}`),

  categoryIdIdx: index('food_categories_category_id_idx').on(table.categoryId),
}));

// Many-to-many: foods <-> allergens/diets/tags.
// Australian Dietary Guidelines serves per 100 g, one row per food.
//
// Imported from AUSNUT 2023's own "Australian Dietary Guidelines profiles"
// workbook, TAB B. AUSNUT has already done the work: it publishes serves per
// 100 g per food, and the figures reconcile exactly with the NHMRC serve
// sizes, checked 2026-11-12:
//
//   Apple, raw           0.667 fruit serves/100 g  ->  150 g per serve
//   Beef mince, cooked   1.538 meat  serves/100 g  ->   65 g per serve
//   Cheese, cheddar      2.500 dairy serves/100 g  ->   40 g per serve
//   Bread, white         2.500 grain serves/100 g  ->   40 g per serve
//
// So there is no hand-built mapping and no hand-written serve-size table to
// drift: this is an import, and the checker reconciles it against the
// published serve sizes rather than trusting it.
//
// A satellite table rather than columns on catalog_foods because this is
// derived data with its own provenance, the same shape as nutrition_profiles.
export const foodAdgServesTable = pgTable('food_adg_serves', {
  foodId: bigint('food_id', { mode: 'number' })
    .references(() => catalogFoodsTable.id, { onDelete: 'cascade' })
    .primaryKey(),

  // The five food groups the ADG daily targets are expressed in.
  grainServes: numeric('grain_serves', { precision: 8, scale: 4, mode: 'number' }),
  vegetableServes: numeric('vegetable_serves', { precision: 8, scale: 4, mode: 'number' }),
  fruitServes: numeric('fruit_serves', { precision: 8, scale: 4, mode: 'number' }),
  dairyServes: numeric('dairy_serves', { precision: 8, scale: 4, mode: 'number' }),
  proteinServes: numeric('protein_serves', { precision: 8, scale: 4, mode: 'number' }),

  // Tracked separately by the guidelines, and needed for the water target.
  waterServes: numeric('water_serves', { precision: 8, scale: 4, mode: 'number' }),
  oilsServes: numeric('oils_serves', { precision: 8, scale: 4, mode: 'number' }),

  // NOT an AUSNUT column. The ADG measures the discretionary allowance in
  // kilojoules (about 600 kJ per serve), not in food-group serves, which is
  // why 334 foods have zero serves in every group above: beer, confectionery
  // and the like. Derived as energy_kj / 600 for foods already carrying the
  // AUSNUT discretionary flag, and 0 for everything else.
  discretionaryServes: numeric('discretionary_serves', { precision: 8, scale: 4, mode: 'number' }),

  sourceName: text('source_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // Serves are a quantity of food: never negative, and a cap that would catch
  // a units mix-up (the largest real value is about 3 serves per 100 g).
  nonNegative: check('food_adg_serves_non_negative',
    sql`${table.grainServes} >= 0 and ${table.vegetableServes} >= 0
        and ${table.fruitServes} >= 0 and ${table.dairyServes} >= 0
        and ${table.proteinServes} >= 0 and ${table.waterServes} >= 0
        and ${table.oilsServes} >= 0 and ${table.discretionaryServes} >= 0`),
}));

export const foodAttributesTable = pgTable('food_attributes', {
  foodId: bigint('food_id', { mode: 'number' })
    .references(() => catalogFoodsTable.id, { onDelete: 'cascade' }).notNull(),
  attributeId: bigint('attribute_id', { mode: 'number' })
    .references(() => attributesTable.id, { onDelete: 'restrict' }).notNull(),

  // -1 unknown, 0 false, 1 true. Tri-state because "we don't know if this is
  // vegan" is genuinely different from "this is not vegan".
  value: smallint('value').notNull(),

  // Open Food Facts keeps allergens_tags (declared) and traces_tags ("may
  // contain") as two legally distinct fields. Collapsing them into `value`
  // would erase the difference between a manufacturer declaring an allergen
  // and merely warning about cross-contamination. NULL for diet flags, where
  // the distinction doesn't apply.
  presence: text('presence'),

  evidence: text('evidence'),
  sourceName: text('source_name'),
}, (table) => ({
  pk: primaryKey({ columns: [table.foodId, table.attributeId] }),

  valueCheck: check('food_attributes_value_check',
    sql`${table.value} IN (-1, 0, 1)`),
  presenceCheck: check('food_attributes_presence_check',
    sql`${table.presence} IS NULL OR ${table.presence} IN ('contains','may_contain','free')`),

  attributeIdIdx: index('food_attributes_attribute_id_idx').on(table.attributeId),
}));

// Global catalogue recipe. Does NOT replace the existing user-owned recipes
// table in schema.js — that stays separate.
export const catalogRecipesTable = pgTable('catalog_recipes', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  publicId: text('public_id').notNull(),

  // 1:1, and always PER SERVING. Whole-recipe totals are derived as
  // per-serving x yield_servings, never stored — one basis, one source of truth.
  nutritionProfileId: bigint('nutrition_profile_id', { mode: 'number' })
    .references(() => nutritionProfilesTable.id).notNull(),

  title: text('title').notNull(),
  normalizedTitle: text('normalized_title').notNull(),
  description: text('description'),

  yieldServings: numeric('yield_servings', { precision: 8, scale: 2, mode: 'number' }).notNull(),
  servingsEstimated: boolean('servings_estimated').default(false).notNull(),
  gramsPerServing: numeric('grams_per_serving', { precision: 12, scale: 4, mode: 'number' }),
  totalWeightG: numeric('total_weight_g', { precision: 12, scale: 4, mode: 'number' }),
  nutritionBasis: text('nutrition_basis').default('per_serving').notNull(),

  // Nullable on purpose: imported sources often omit these, and a NOT NULL
  // column would reintroduce the parseInt(x) || 0 bug that stores fake zeros.
  prepTimeMin: integer('prep_time_min'),
  cookTimeMin: integer('cook_time_min'),

  primaryImageUrl: text('primary_image_url'),
  rating: numeric('rating', { precision: 3, scale: 2, mode: 'number' }),

  sourceName: text('source_name').notNull(),
  sourceRecordId: text('source_record_id'),
  sourceLicense: text('source_license').notNull(),
  verificationStatus: text('verification_status').notNull(),
  isActive: boolean('is_active').default(true).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  publicIdUnique: uniqueIndex('catalog_recipes_public_id_unique').on(table.publicId),
  publicIdCheck: check('catalog_recipes_public_id_check',
    sql`${table.publicId} LIKE 'recipe\\_%'`),

  profileUnique: uniqueIndex('catalog_recipes_profile_unique').on(table.nutritionProfileId),

  nutritionBasisCheck: check('catalog_recipes_nutrition_basis_check',
    sql`${table.nutritionBasis} = 'per_serving'`),
  yieldServingsCheck: check('catalog_recipes_yield_servings_check',
    sql`${table.yieldServings} > 0`),

  sourceRecordUnique: uniqueIndex('catalog_recipes_source_record_unique')
    .on(table.sourceName, table.sourceRecordId),
  titleTrgm: index('catalog_recipes_normalized_title_trgm')
    .using('gin', table.normalizedTitle.op('gin_trgm_ops')),
}));

// display_text ALWAYS survives; food_id gets filled in during mapping.
export const recipeIngredientsTable = pgTable('recipe_ingredients', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),

  recipeId: bigint('recipe_id', { mode: 'number' })
    .references(() => catalogRecipesTable.id, { onDelete: 'cascade' }).notNull(),

  // NULLABLE: a wrong match is worse than no match. Unmapped ingredients are
  // still storable via display_text; "every ingredient mapped" is enforced by
  // the import pipeline as a condition of verification_status = 'verified',
  // not by a NOT NULL column here.
  foodId: bigint('food_id', { mode: 'number' })
    .references(() => catalogFoodsTable.id, { onDelete: 'set null' }),
  foodServingId: bigint('food_serving_id', { mode: 'number' }),

  position: integer('position').notNull(),
  quantity: numeric('quantity', { precision: 12, scale: 4, mode: 'number' }).notNull(),
  gramWeight: numeric('gram_weight', { precision: 12, scale: 4, mode: 'number' }),
  displayText: text('display_text').notNull(),
  preparationNote: text('preparation_note'),
}, (table) => ({
  recipePositionUnique: uniqueIndex('recipe_ingredients_recipe_position_unique')
    .on(table.recipeId, table.position),

  // THE constraint: a serving must belong to the SAME food this ingredient
  // points at. Without it you could attach "1 stubby of beer" to an ingredient
  // whose food is flour. Targets the UNIQUE(id, food_id) on catalog_food_servings.
  servingBelongsToFood: foreignKey({
    columns: [table.foodServingId, table.foodId],
    foreignColumns: [catalogFoodServingsTable.id, catalogFoodServingsTable.foodId],
    name: 'recipe_ingredients_serving_belongs_to_food_fk',
  }).onDelete('set null'),

  // You can't pick a serving without first picking a food.
  servingRequiresFood: check('recipe_ingredients_serving_requires_food',
    sql`${table.foodServingId} IS NULL OR ${table.foodId} IS NOT NULL`),

  foodIdIdx: index('recipe_ingredients_food_id_idx').on(table.foodId),
}));


export const recipeStepsTable = pgTable('recipe_steps', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  recipeId: bigint('recipe_id', { mode: 'number' })
    .references(() => catalogRecipesTable.id, { onDelete: 'cascade' }).notNull(),
  stepNumber: integer('step_number').notNull(),
  instruction: text('instruction').notNull(),
  durationMin: integer('duration_min'),
  imageUrl: text('image_url'),
}, (table) => ({
  recipeStepUnique: uniqueIndex('recipe_steps_recipe_step_unique').on(table.recipeId, table.stepNumber),
  stepNumberCheck: check('recipe_steps_step_number_check', sql`${table.stepNumber} > 0`),
}));

export const foodAliasesTable = pgTable('food_aliases', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  foodId: bigint('food_id', { mode: 'number' })
    .references(() => catalogFoodsTable.id, { onDelete: 'cascade' }).notNull(),
  alias: text('alias').notNull(),
  normalizedAlias: text('normalized_alias').notNull(),
  language: text('language').default('en').notNull(),
}, (table) => ({
  aliasUnique: uniqueIndex('food_aliases_unique').on(table.foodId, table.normalizedAlias, table.language),
  // Same trigram search path as catalog_foods.normalized_name — aliases are
  // half the point of search ("chook" -> chicken).
  aliasTrgm: index('food_aliases_normalized_alias_trgm')
    .using('gin', table.normalizedAlias.op('gin_trgm_ops')),
}));

export const recipeAliasesTable = pgTable('recipe_aliases', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  recipeId: bigint('recipe_id', { mode: 'number' })
    .references(() => catalogRecipesTable.id, { onDelete: 'cascade' }).notNull(),
  alias: text('alias').notNull(),
  normalizedAlias: text('normalized_alias').notNull(),
  language: text('language').default('en').notNull(),
}, (table) => ({
  aliasUnique: uniqueIndex('recipe_aliases_unique').on(table.recipeId, table.normalizedAlias, table.language),
  aliasTrgm: index('recipe_aliases_normalized_alias_trgm')
    .using('gin', table.normalizedAlias.op('gin_trgm_ops')),
}));

export const foodImagesTable = pgTable('food_images', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  foodId: bigint('food_id', { mode: 'number' })
    .references(() => catalogFoodsTable.id, { onDelete: 'cascade' }).notNull(),
  url: text('url').notNull(),
  altText: text('alt_text'),
  imageType: text('image_type'),
  isPrimary: boolean('is_primary').default(false).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  rightsLicense: text('rights_license'),
  sourceUrl: text('source_url'),
}, (table) => ({
  onePrimaryPerFood: uniqueIndex('food_images_one_primary')
    .on(table.foodId).where(sql`${table.isPrimary}`),
  foodIdIdx: index('food_images_food_id_idx').on(table.foodId),
}));

export const recipeImagesTable = pgTable('recipe_images', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  recipeId: bigint('recipe_id', { mode: 'number' })
    .references(() => catalogRecipesTable.id, { onDelete: 'cascade' }).notNull(),
  url: text('url').notNull(),
  altText: text('alt_text'),
  isPrimary: boolean('is_primary').default(false).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  rightsLicense: text('rights_license'),
  sourceUrl: text('source_url'),
}, (table) => ({
  onePrimaryPerRecipe: uniqueIndex('recipe_images_one_primary')
    .on(table.recipeId).where(sql`${table.isPrimary}`),
  recipeIdIdx: index('recipe_images_recipe_id_idx').on(table.recipeId),
}));

// Mirrors of food_categories / food_attributes.
export const recipeCategoriesTable = pgTable('recipe_categories', {
  recipeId: bigint('recipe_id', { mode: 'number' })
    .references(() => catalogRecipesTable.id, { onDelete: 'cascade' }).notNull(),
  categoryId: bigint('category_id', { mode: 'number' })
    .references(() => categoriesTable.id, { onDelete: 'restrict' }).notNull(),
  isPrimary: boolean('is_primary').default(false).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.recipeId, table.categoryId] }),
  onePrimaryPerRecipe: uniqueIndex('recipe_categories_one_primary')
    .on(table.recipeId).where(sql`${table.isPrimary}`),
  categoryIdIdx: index('recipe_categories_category_id_idx').on(table.categoryId),
}));

export const recipeAttributesTable = pgTable('recipe_attributes', {
  recipeId: bigint('recipe_id', { mode: 'number' })
    .references(() => catalogRecipesTable.id, { onDelete: 'cascade' }).notNull(),
  attributeId: bigint('attribute_id', { mode: 'number' })
    .references(() => attributesTable.id, { onDelete: 'restrict' }).notNull(),
  value: smallint('value').notNull(),
  presence: text('presence'),
  // TRUE when derived from ingredient foods rather than stated by a human.
  // Lets you re-derive on re-import without clobbering reviewed overrides.
  isDerived: boolean('is_derived').default(true).notNull(),
  evidence: text('evidence'),
}, (table) => ({
  pk: primaryKey({ columns: [table.recipeId, table.attributeId] }),
  valueCheck: check('recipe_attributes_value_check', sql`${table.value} IN (-1, 0, 1)`),
  presenceCheck: check('recipe_attributes_presence_check',
    sql`${table.presence} IS NULL OR ${table.presence} IN ('contains','may_contain','free')`),
  attributeIdIdx: index('recipe_attributes_attribute_id_idx').on(table.attributeId),
}));
/**
 * Label reports from the barcode scanner: what a user typed off a pack we do
 * not hold (barcode redesign, checklist b2-01). This is the only table in the
 * catalogue written by the app rather than by an importer, so it is kept
 * deliberately separate from catalog_foods: a report is a CLAIM, and it is
 * reviewed before any of it reaches the catalogue.
 *
 * One row per (barcode, reporter): a second send from the same person for the
 * same pack corrects their first, it does not pile up. Two different people
 * reporting the same barcode DO make two rows, which is the point — agreement
 * between strangers is the strongest signal we get that the numbers are right.
 *
 * Energy is stored as the user typed it, in kJ, because that is what the
 * Australian label prints and what they read off the pack. Converting at write
 * time would hide a typo behind a rounding.
 */
export const catalogBarcodeReportsTable = pgTable('catalog_barcode_reports', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  barcode: text('barcode').notNull(),
  barcodeType: text('barcode_type'),

  // What the pack says. Name, serving size and energy are required by the form.
  productName: text('product_name').notNull(),
  brand: text('brand'),
  servingSize: numeric('serving_size', { precision: 10, scale: 2 }).notNull(),
  servingUnit: text('serving_unit').default('g').notNull(),
  energyKj: numeric('energy_kj', { precision: 10, scale: 2 }).notNull(),
  proteinG: numeric('protein_g', { precision: 10, scale: 2 }),
  carbohydrateG: numeric('carbohydrate_g', { precision: 10, scale: 2 }),
  fatG: numeric('fat_g', { precision: 10, scale: 2 }),

  // Optional photo of the nutrition panel, through the existing upload path.
  // It is what makes a report verifiable rather than merely plausible.
  photoUrl: text('photo_url'),

  reportedBy: text('reported_by').notNull(),
  appVersion: text('app_version'),

  // new -> checked -> added | rejected. Nothing here is trusted until a human
  // has compared it with the photo or the pack.
  status: text('status').default('new').notNull(),
  reviewNote: text('review_note'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  reporterBarcodeUnique: uniqueIndex('catalog_barcode_reports_reporter_unique')
    .on(table.barcode, table.reportedBy),
  // The review queue reads "everything new, oldest first" and "everything for
  // this barcode", so both get an index.
  statusCreatedIdx: index('catalog_barcode_reports_status_created_idx')
    .on(table.status, table.createdAt),
  barcodeIdx: index('catalog_barcode_reports_barcode_idx').on(table.barcode),
  statusCheck: check('catalog_barcode_reports_status_check',
    sql`${table.status} IN ('new','checked','added','rejected')`),
  servingUnitCheck: check('catalog_barcode_reports_serving_unit_check',
    sql`${table.servingUnit} IN ('g','ml')`),
  // Cheap guards at the storage layer as well as in the service: a value that
  // cannot be true should not be storable, whatever calls the insert.
  servingSizeCheck: check('catalog_barcode_reports_serving_size_check',
    sql`${table.servingSize} > 0 AND ${table.servingSize} <= 5000`),
  energyCheck: check('catalog_barcode_reports_energy_check',
    sql`${table.energyKj} >= 0 AND ${table.energyKj} <= 20000`),
}));
