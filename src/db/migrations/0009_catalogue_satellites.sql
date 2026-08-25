CREATE TABLE "food_aliases" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "food_aliases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"food_id" bigint NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "food_images" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "food_images_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"food_id" bigint NOT NULL,
	"url" text NOT NULL,
	"alt_text" text,
	"image_type" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"rights_license" text,
	"source_url" text
);
--> statement-breakpoint
CREATE TABLE "recipe_aliases" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_aliases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"recipe_id" bigint NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_attributes" (
	"recipe_id" bigint NOT NULL,
	"attribute_id" bigint NOT NULL,
	"value" smallint NOT NULL,
	"presence" text,
	"is_derived" boolean DEFAULT true NOT NULL,
	"evidence" text,
	CONSTRAINT "recipe_attributes_recipe_id_attribute_id_pk" PRIMARY KEY("recipe_id","attribute_id"),
	CONSTRAINT "recipe_attributes_value_check" CHECK ("recipe_attributes"."value" IN (-1, 0, 1)),
	CONSTRAINT "recipe_attributes_presence_check" CHECK ("recipe_attributes"."presence" IS NULL OR "recipe_attributes"."presence" IN ('contains','may_contain','free'))
);
--> statement-breakpoint
CREATE TABLE "recipe_categories" (
	"recipe_id" bigint NOT NULL,
	"category_id" bigint NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "recipe_categories_recipe_id_category_id_pk" PRIMARY KEY("recipe_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "recipe_images" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_images_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"recipe_id" bigint NOT NULL,
	"url" text NOT NULL,
	"alt_text" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"rights_license" text,
	"source_url" text
);
--> statement-breakpoint
CREATE TABLE "recipe_steps" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "recipe_steps_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"recipe_id" bigint NOT NULL,
	"step_number" integer NOT NULL,
	"instruction" text NOT NULL,
	"duration_min" integer,
	"image_url" text,
	CONSTRAINT "recipe_steps_step_number_check" CHECK ("recipe_steps"."step_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "food_aliases" ADD CONSTRAINT "food_aliases_food_id_catalog_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."catalog_foods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_images" ADD CONSTRAINT "food_images_food_id_catalog_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."catalog_foods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_aliases" ADD CONSTRAINT "recipe_aliases_recipe_id_catalog_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."catalog_recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_attributes" ADD CONSTRAINT "recipe_attributes_recipe_id_catalog_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."catalog_recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_attributes" ADD CONSTRAINT "recipe_attributes_attribute_id_attributes_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."attributes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_categories" ADD CONSTRAINT "recipe_categories_recipe_id_catalog_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."catalog_recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_categories" ADD CONSTRAINT "recipe_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_images" ADD CONSTRAINT "recipe_images_recipe_id_catalog_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."catalog_recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_steps" ADD CONSTRAINT "recipe_steps_recipe_id_catalog_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."catalog_recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "food_aliases_unique" ON "food_aliases" USING btree ("food_id","normalized_alias","language");--> statement-breakpoint
CREATE INDEX "food_aliases_normalized_alias_trgm" ON "food_aliases" USING gin ("normalized_alias" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "food_images_one_primary" ON "food_images" USING btree ("food_id") WHERE "food_images"."is_primary";--> statement-breakpoint
CREATE INDEX "food_images_food_id_idx" ON "food_images" USING btree ("food_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_aliases_unique" ON "recipe_aliases" USING btree ("recipe_id","normalized_alias","language");--> statement-breakpoint
CREATE INDEX "recipe_aliases_normalized_alias_trgm" ON "recipe_aliases" USING gin ("normalized_alias" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "recipe_attributes_attribute_id_idx" ON "recipe_attributes" USING btree ("attribute_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_categories_one_primary" ON "recipe_categories" USING btree ("recipe_id") WHERE "recipe_categories"."is_primary";--> statement-breakpoint
CREATE INDEX "recipe_categories_category_id_idx" ON "recipe_categories" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_images_one_primary" ON "recipe_images" USING btree ("recipe_id") WHERE "recipe_images"."is_primary";--> statement-breakpoint
CREATE INDEX "recipe_images_recipe_id_idx" ON "recipe_images" USING btree ("recipe_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_steps_recipe_step_unique" ON "recipe_steps" USING btree ("recipe_id","step_number");