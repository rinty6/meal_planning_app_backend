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
ALTER TABLE "recommendation_feedback" ADD CONSTRAINT "recommendation_feedback_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE cascade ON UPDATE no action;