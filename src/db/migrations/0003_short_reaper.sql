ALTER TABLE "favourites" RENAME COLUMN "recipe_id" TO "external_id";--> statement-breakpoint
ALTER TABLE "favourites" ALTER COLUMN "image" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "favourites" ALTER COLUMN "cook_time" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "favourites" ALTER COLUMN "servings" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "favourites" ALTER COLUMN "servings" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "favourites" ADD COLUMN "calories" real NOT NULL;--> statement-breakpoint
ALTER TABLE "favourites" ADD COLUMN "protein" real DEFAULT 0;--> statement-breakpoint
ALTER TABLE "favourites" ADD COLUMN "carbs" real DEFAULT 0;--> statement-breakpoint
ALTER TABLE "favourites" ADD COLUMN "fats" real DEFAULT 0;