ALTER TABLE "catalog_foods" ADD COLUMN "servability" text;--> statement-breakpoint
ALTER TABLE "catalog_foods" ADD COLUMN "servability_reason" text;--> statement-breakpoint
CREATE INDEX "catalog_foods_servability_idx" ON "catalog_foods" USING btree ("servability") WHERE "catalog_foods"."servability" = 'servable';--> statement-breakpoint
ALTER TABLE "catalog_foods" ADD CONSTRAINT "catalog_foods_servability_check" CHECK ("catalog_foods"."servability" IS NULL
        OR "catalog_foods"."servability" IN ('servable', 'component', 'ingredient'));