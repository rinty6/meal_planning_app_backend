CREATE TABLE "food_attributes" (
	"food_id" bigint NOT NULL,
	"attribute_id" bigint NOT NULL,
	"value" smallint NOT NULL,
	"presence" text,
	"evidence" text,
	"source_name" text,
	CONSTRAINT "food_attributes_food_id_attribute_id_pk" PRIMARY KEY("food_id","attribute_id"),
	CONSTRAINT "food_attributes_value_check" CHECK ("food_attributes"."value" IN (-1, 0, 1)),
	CONSTRAINT "food_attributes_presence_check" CHECK ("food_attributes"."presence" IS NULL OR "food_attributes"."presence" IN ('contains','may_contain','free'))
);
--> statement-breakpoint
CREATE TABLE "food_categories" (
	"food_id" bigint NOT NULL,
	"category_id" bigint NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "food_categories_food_id_category_id_pk" PRIMARY KEY("food_id","category_id")
);
--> statement-breakpoint
ALTER TABLE "food_attributes" ADD CONSTRAINT "food_attributes_food_id_catalog_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."catalog_foods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_attributes" ADD CONSTRAINT "food_attributes_attribute_id_attributes_id_fk" FOREIGN KEY ("attribute_id") REFERENCES "public"."attributes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_categories" ADD CONSTRAINT "food_categories_food_id_catalog_foods_id_fk" FOREIGN KEY ("food_id") REFERENCES "public"."catalog_foods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_categories" ADD CONSTRAINT "food_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "food_attributes_attribute_id_idx" ON "food_attributes" USING btree ("attribute_id");--> statement-breakpoint
CREATE UNIQUE INDEX "food_categories_one_primary" ON "food_categories" USING btree ("food_id") WHERE "food_categories"."is_primary";--> statement-breakpoint
CREATE INDEX "food_categories_category_id_idx" ON "food_categories" USING btree ("category_id");