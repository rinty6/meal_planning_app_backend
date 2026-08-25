CREATE EXTENSION IF NOT EXISTS pg_trgm; --> statement-breakpoint

CREATE TABLE "catalog_foods" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalog_foods_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"public_id" text NOT NULL,
	"brand_id" bigint,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"base_name" text,
	"name_segments" text[],
	"description" text,
	"food_type" text NOT NULL,
	"barcode" text,
	"barcode_type" text,
	"primary_image_url" text,
	"region" text NOT NULL,
	"language" text NOT NULL,
	"source_name" text NOT NULL,
	"source_record_id" text,
	"source_license" text NOT NULL,
	"verification_status" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_foods_public_id_check" CHECK ("catalog_foods"."public_id" LIKE 'food\_%')
);
--> statement-breakpoint
ALTER TABLE "catalog_foods" ADD CONSTRAINT "catalog_foods_brand_id_catalog_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."catalog_brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_foods_public_id_unique" ON "catalog_foods" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_foods_source_record_unique" ON "catalog_foods" USING btree ("source_name","source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_foods_barcode_region_unique" ON "catalog_foods" USING btree ("barcode","region") WHERE "catalog_foods"."barcode" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "catalog_foods_name_segments_gin" ON "catalog_foods" USING gin ("name_segments");--> statement-breakpoint
CREATE INDEX "catalog_foods_normalized_name_trgm" ON "catalog_foods" USING gin ("normalized_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "catalog_foods_base_name_idx" ON "catalog_foods" USING btree ("base_name");--> statement-breakpoint
CREATE INDEX "catalog_foods_brand_id_idx" ON "catalog_foods" USING btree ("brand_id");