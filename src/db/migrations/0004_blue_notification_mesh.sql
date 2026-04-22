CREATE TABLE "user_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"push_token" text NOT NULL,
	"platform" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_devices_push_token_unique" ON "user_devices" USING btree ("push_token");
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
ALTER TABLE "user_info" DROP COLUMN IF EXISTS "expo_push_token";
--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_info_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_info"("id") ON DELETE cascade ON UPDATE no action;
