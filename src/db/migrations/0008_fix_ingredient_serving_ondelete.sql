ALTER TABLE "recipe_ingredients" DROP CONSTRAINT "recipe_ingredients_serving_belongs_to_food_fk";
--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_serving_belongs_to_food_fk" FOREIGN KEY ("food_serving_id","food_id") REFERENCES "public"."catalog_food_servings"("id","food_id") ON DELETE set null ON UPDATE no action;