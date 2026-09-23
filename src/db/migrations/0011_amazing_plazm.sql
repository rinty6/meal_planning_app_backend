CREATE TABLE "catalog_barcode_reports" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalog_barcode_reports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"barcode" text NOT NULL,
	"barcode_type" text,
	"product_name" text NOT NULL,
	"brand" text,
	"serving_size" numeric(10, 2) NOT NULL,
	"serving_unit" text DEFAULT 'g' NOT NULL,
	"energy_kj" numeric(10, 2) NOT NULL,
	"protein_g" numeric(10, 2),
	"carbohydrate_g" numeric(10, 2),
	"fat_g" numeric(10, 2),
	"photo_url" text,
	"reported_by" text NOT NULL,
	"app_version" text,
	"status" text DEFAULT 'new' NOT NULL,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_barcode_reports_status_check" CHECK ("catalog_barcode_reports"."status" IN ('new','checked','added','rejected')),
	CONSTRAINT "catalog_barcode_reports_serving_unit_check" CHECK ("catalog_barcode_reports"."serving_unit" IN ('g','ml')),
	CONSTRAINT "catalog_barcode_reports_serving_size_check" CHECK ("catalog_barcode_reports"."serving_size" > 0 AND "catalog_barcode_reports"."serving_size" <= 5000),
	CONSTRAINT "catalog_barcode_reports_energy_check" CHECK ("catalog_barcode_reports"."energy_kj" >= 0 AND "catalog_barcode_reports"."energy_kj" <= 20000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_barcode_reports_reporter_unique" ON "catalog_barcode_reports" USING btree ("barcode","reported_by");--> statement-breakpoint
CREATE INDEX "catalog_barcode_reports_status_created_idx" ON "catalog_barcode_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "catalog_barcode_reports_barcode_idx" ON "catalog_barcode_reports" USING btree ("barcode");