CREATE TABLE "catalog_recipes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalog_recipes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"nutrition_profile_id" bigint NOT NULL,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"description" text,
	"yield_servings" numeric(8, 2) NOT NULL,
	"servings_estimated" boolean DEFAULT false NOT NULL,
	"grams_per_serving" numeric(12, 4),
	"total_weight_g" numeric(12, 4),
	"nutrition_basis" text DEFAULT 'per_serving' NOT NULL,
	"prep_time_min" integer,
	"cook_time_min" integer,
	"primary_image_url" text,
	"rating" numeric(3, 2),
	"source_name" text NOT NULL,
	"source_record_id" text,
	"source_license" text NOT NULL,
	"verification_status" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_recipes_public_id_check" CHECK ("catalog_recipes"."public_id" LIKE 'recipe\_%'),
	CONSTRAINT "catalog_recipes_nutrition_basis_check" CHECK ("catalog_recipes"."nutrition_basis" = 'per_serving'),
	CONSTRAINT "catalog_recipes_yield_servings_check" CHECK ("catalog_recipes"."yield_servings" > 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredients" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_ingredients_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"recipe_id" bigint NOT NULL,
	"food_id" bigint,
	"food_serving_id" bigint,
	"position" integer NOT NULL,
	"quantity" numeric(12, 4) NOT NULL,
	"gram_weight" numeric(12, 4),
	"display_text" text NOT NULL,
	"preparation_note" text,
	CONSTRAINT "recipe_ingredients_serving_requires_food" CHECK ("recipe_ingredients"."food_serving_id" IS NULL OR "recipe_ingredients"."food_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "catalog_recipes" ADD CONSTRAINT "catalog_recipes_nutrition_profile_id_nutrition_profiles_id_fk" FOREIGN KEY ("nutrition_profile_id") REFERENCES "public"."nutrition_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_catalog_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."catalog_recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_food_id_catalog_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."catalog_foods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_serving_belongs_to_food_fk" FOREIGN KEY ("food_serving_id","food_id") REFERENCES "public"."catalog_food_servings"("id","food_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_recipes_public_id_unique" ON "catalog_recipes" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_recipes_profile_unique" ON "catalog_recipes" USING btree ("nutrition_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_recipes_source_record_unique" ON "catalog_recipes" USING btree ("source_name","source_record_id");--> statement-breakpoint
CREATE INDEX "catalog_recipes_normalized_title_trgm" ON "catalog_recipes" USING gin ("normalized_title" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_ingredients_recipe_position_unique" ON "recipe_ingredients" USING btree ("recipe_id","position");--> statement-breakpoint
CREATE INDEX "recipe_ingredients_food_id_idx" ON "recipe_ingredients" USING btree ("food_id");