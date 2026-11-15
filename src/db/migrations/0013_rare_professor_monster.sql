CREATE TABLE "food_adg_serves" (
	"food_id" bigint PRIMARY KEY NOT NULL,
	"grain_serves" numeric(8, 4),
	"vegetable_serves" numeric(8, 4),
	"fruit_serves" numeric(8, 4),
	"dairy_serves" numeric(8, 4),
	"protein_serves" numeric(8, 4),
	"water_serves" numeric(8, 4),
	"oils_serves" numeric(8, 4),
	"discretionary_serves" numeric(8, 4),
	"source_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "food_adg_serves_non_negative" CHECK ("food_adg_serves"."grain_serves" >= 0 and "food_adg_serves"."vegetable_serves" >= 0
        and "food_adg_serves"."fruit_serves" >= 0 and "food_adg_serves"."dairy_serves" >= 0
        and "food_adg_serves"."protein_serves" >= 0 and "food_adg_serves"."water_serves" >= 0
        and "food_adg_serves"."oils_serves" >= 0 and "food_adg_serves"."discretionary_serves" >= 0)
);
--> statement-breakpoint
ALTER TABLE "nutrition_profiles" ADD COLUMN "alcohol_g" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "food_adg_serves" ADD CONSTRAINT "food_adg_serves_food_id_catalog_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."catalog_foods"("id") ON DELETE cascade ON UPDATE no action;