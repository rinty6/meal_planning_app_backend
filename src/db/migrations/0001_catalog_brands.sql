CREATE TABLE "catalog_brands" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalog_brands_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"website_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_brands_name_unique" ON "catalog_brands" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_brands_normalized_name_unique" ON "catalog_brands" USING btree ("normalized_name");