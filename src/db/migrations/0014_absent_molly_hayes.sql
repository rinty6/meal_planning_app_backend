ALTER TYPE "public"."activity_level" ADD VALUE 'sedentary' BEFORE 'lightly_active';--> statement-breakpoint
ALTER TABLE "demographics" ADD COLUMN "is_pregnant" boolean;--> statement-breakpoint
ALTER TABLE "demographics" ADD COLUMN "is_breastfeeding" boolean;