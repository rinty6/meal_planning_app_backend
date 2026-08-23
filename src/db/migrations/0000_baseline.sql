CREATE TYPE "public"."activity_level" AS ENUM('lightly_active', 'moderately_active', 'very_active', 'super_active');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('male', 'female', 'other');--> statement-breakpoint
CREATE TYPE "public"."goal" AS ENUM('lose_weight', 'gain_muscle', 'maintain');--> statement-breakpoint
CREATE TYPE "public"."height_unit" AS ENUM('cm', 'ft');--> statement-breakpoint
CREATE TYPE "public"."weight_unit" AS ENUM('kg', 'lbs');--> statement-breakpoint
CREATE TABLE "calorie_goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"goal_name" text NOT NULL,
	"daily_calories" integer NOT NULL,
	"description" text,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"notifications_enabled" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
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
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"image" text,
	"calories" real NOT NULL,
	"protein" real DEFAULT 0,
	"carbs" real DEFAULT 0,
	"fats" real DEFAULT 0,
	"cook_time" text,
	"servings" integer DEFAULT 1,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meal_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"date" date NOT NULL,
	"meal_type" text NOT NULL,
	"food_name" text NOT NULL,
	"calories" real NOT NULL,
	"protein" real,
	"carbs" real,
	"fats" real,
	"image" text,
	"external_id" text,
	"source" text,
	"serving_id" text,
	"serving_description" text,
	"servings" real DEFAULT 1,
	"nutrients" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "meal_plan_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"clerk_id" text,
	"event_type" text NOT NULL,
	"meal_type" text,
	"item_id" text,
	"item_title" text,
	"source" text,
	"rank" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meal_plan_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"allergens" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"diets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"nutrient_limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plan_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "notification_dispatch_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"reminder_type" text NOT NULL,
	"local_date" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "recommendation_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"clerk_id" text,
	"combo_id" text NOT NULL,
	"meal_type" text NOT NULL,
	"status" text NOT NULL,
	"ml_tag" text,
	"explanation" text,
	"item_titles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopping_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"list_id" integer NOT NULL,
	"name" text NOT NULL,
	"is_checked" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "shopping_lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"push_token" text NOT NULL,
	"platform" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_info" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"notifications_master_enabled" boolean DEFAULT true,
	"timezone" text DEFAULT 'Australia/Adelaide',
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_info_clerk_id_unique" UNIQUE("clerk_id"),
	CONSTRAINT "user_info_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "calorie_goals" ADD CONSTRAINT "calorie_goals_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demographics" ADD CONSTRAINT "demographics_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favourites" ADD CONSTRAINT "favourites_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_logs" ADD CONSTRAINT "meal_logs_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_events" ADD CONSTRAINT "meal_plan_events_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_preferences" ADD CONSTRAINT "meal_plan_preferences_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_dispatch_log" ADD CONSTRAINT "notification_dispatch_log_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_feedback" ADD CONSTRAINT "recommendation_feedback_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_items" ADD CONSTRAINT "shopping_items_list_id_shopping_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."shopping_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_lists" ADD CONSTRAINT "shopping_lists_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meal_plan_events_user_created_at_idx" ON "meal_plan_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meal_plan_preferences_user_id_idx" ON "meal_plan_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_dispatch_unique" ON "notification_dispatch_log" USING btree ("user_id","reminder_type","local_date");--> statement-breakpoint
CREATE INDEX "notifications_user_created_at_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "recommendation_feedback_user_created_at_idx" ON "recommendation_feedback" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_devices_push_token_unique" ON "user_devices" USING btree ("push_token");