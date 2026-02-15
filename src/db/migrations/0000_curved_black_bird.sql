CREATE TYPE "public"."activity_level" AS ENUM('lightly_active', 'moderately_active', 'very_active', 'super_active');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('male', 'female', 'other');--> statement-breakpoint
CREATE TYPE "public"."goal" AS ENUM('lose_weight', 'gain_muscle', 'maintain');--> statement-breakpoint
CREATE TYPE "public"."height_unit" AS ENUM('cm', 'ft');--> statement-breakpoint
CREATE TYPE "public"."weight_unit" AS ENUM('kg', 'lbs');--> statement-breakpoint
CREATE TABLE "demographics" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"height" real,
	"weight" real,
	"preferred_weight_unit" "weight_unit" DEFAULT 'kg',
	"preferred_height_unit" "height_unit" DEFAULT 'cm',
	"gender" "gender",
	"date_of_birth" date,
	"activity_level" "activity_level",
	"goal" "goal",
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "demographics_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "favourites" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"recipe_id" integer NOT NULL,
	"title" text NOT NULL,
	"image" text NOT NULL,
	"cook_time" text NOT NULL,
	"servings" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "favourites_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "user_info" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_info_clerk_id_unique" UNIQUE("clerk_id"),
	CONSTRAINT "user_info_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "demographics" ADD CONSTRAINT "demographics_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favourites" ADD CONSTRAINT "favourites_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE no action ON UPDATE no action;