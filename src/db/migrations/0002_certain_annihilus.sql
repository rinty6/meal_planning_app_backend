CREATE TABLE "recipes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"fatsecret_id" text,
	"title" text NOT NULL,
	"image" text,
	"prep_time_min" integer DEFAULT 0,
	"cook_time_min" integer DEFAULT 0,
	"servings" integer DEFAULT 1,
	"calories" real NOT NULL,
	"protein" real DEFAULT 0,
	"carbs" real DEFAULT 0,
	"fats" real DEFAULT 0,
	"ingredients" json DEFAULT '[]'::json,
	"instructions" json DEFAULT '[]'::json,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "favourites" DROP CONSTRAINT "favourites_user_id_unique";--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE no action ON UPDATE no action;