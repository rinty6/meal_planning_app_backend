CREATE TABLE "catalog_food_servings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalog_food_servings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"food_id" bigint NOT NULL,
	"nutrition_profile_id" bigint NOT NULL,
	"description" text NOT NULL,
	"number_of_units" numeric(12, 4) NOT NULL,
	"measurement_description" text NOT NULL,
	"metric_amount" numeric(12, 4),
	"metric_unit" text,
	"grams_equivalent" numeric(12, 4),
	"millilitres_equivalent" numeric(12, 4),
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_food_servings_metric_unit_check" CHECK ("catalog_food_servings"."metric_unit" IS NULL OR "catalog_food_servings"."metric_unit" IN ('g','ml','oz'))
);
--> statement-breakpoint
ALTER TABLE "catalog_food_servings" ADD CONSTRAINT "catalog_food_servings_food_id_catalog_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."catalog_foods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_food_servings" ADD CONSTRAINT "catalog_food_servings_nutrition_profile_id_nutrition_profiles_id_fk" FOREIGN KEY ("nutrition_profile_id") REFERENCES "public"."nutrition_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_food_servings_profile_unique" ON "catalog_food_servings" USING btree ("nutrition_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_food_servings_one_default" ON "catalog_food_servings" USING btree ("food_id") WHERE "catalog_food_servings"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_food_servings_id_food_unique" ON "catalog_food_servings" USING btree ("id","food_id");--> statement-breakpoint
CREATE INDEX "catalog_food_servings_food_id_idx" ON "catalog_food_servings" USING btree ("food_id");