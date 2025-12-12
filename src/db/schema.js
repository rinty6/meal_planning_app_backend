import {pgTable, serial, text, timestamp, integer} from 'drizzle-orm/pg-core';


// This file will create relational tables in the database using Drizzle ORM
export const favouritesTable = pgTable('favourites', {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull(),
    recipeId: integer('recipe_id').notNull(),
    title: text("title").notNull(),
    image: text("image").notNull(),
    cookTime: text("cook_time").notNull(),
    servings: integer("servings").notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});