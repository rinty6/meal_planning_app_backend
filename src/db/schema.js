// This file will create relational tables in the database using Drizzle ORM
import {pgTable, serial, text, timestamp, integer, pgEnum, real, date, json, boolean} from 'drizzle-orm/pg-core';

// 1. Define Enums (Strict lists of options)
// This list is created to store the activity level of each user after sign up process
export const activityLevelEnum = pgEnum('activity_level', [
  'lightly_active', 
  'moderately_active', 
  'very_active', 
  'super_active'
]);

// This list is created to store the sex of each user after sign up process
export const genderEnum = pgEnum('gender', ['male', 'female', 'other']);

// This list is created to store the goal(s) of each user after sign up process
export const goalEnum = pgEnum('goal', ['lose_weight', 'gain_muscle', 'maintain']);

// Convert and make sure the consistency whenever users input their height and weight data
export const weightUnitEnum = pgEnum('weight_unit', ['kg', 'lbs']);
export const heightUnitEnum = pgEnum('height_unit', ['cm', 'ft']);

// This table stores the favorite dish(s) or foods of each user.
// This will be used at the planning page
export const favouritesTable = pgTable('favourites', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => usersTable.userId).notNull(),
  
  // Renamed from recipeId to externalId to handle Food IDs too
  externalId: text('external_id').notNull(), 
  
  title: text("title").notNull(),
  image: text("image"), // Can be null for generic foods
  
  // NEW: Nutritional Info
  calories: real('calories').notNull(),
  protein: real('protein').default(0),
  carbs: real('carbs').default(0),
  fats: real('fats').default(0),
  
  // Optional fields (Foods might not have these)
  cookTime: text("cook_time"), 
  servings: integer("servings").default(1),
  
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// This table will store the user information after they sign up sucessfully
export const usersTable = pgTable('user_info', {
    userId: serial('id').primaryKey(),
    clerkId: text('clerk_id').notNull().unique(),
    email: text('email').notNull().unique(),
    username: text('name').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const demographicsTable = pgTable('demographics', {
  demographicsId: serial('id').primaryKey(),
  
  // The Link: This connects this profile to a specific user
  userId: integer('user_id').references(() => usersTable.userId).notNull().unique(),
  height: real('height'), 
  weight: real('weight'), 
  // THE PREFERENCES (How the user wants to see it)
  // This tells your UI: "Even though I stored 180cm, show this user 5'11""
  preferredWeightUnit: weightUnitEnum('preferred_weight_unit').default('kg'),
  preferredHeightUnit: heightUnitEnum('preferred_height_unit').default('cm'),
  // Health Data. This will be later used for building Ml models
  gender: genderEnum('gender'),
  dateOfBirth: date('date_of_birth'), // Store DOB, calculate age in the app
  activityLevel: activityLevelEnum('activity_level'),
  goal: goalEnum('goal'), 
  updatedAt: timestamp('updated_at').defaultNow(),
});


// This table stores the meal detail whenever users add a dish at the meal planning page
export const mealLogsTable = pgTable('meal_logs', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => usersTable.userId).notNull(),
  
  // Which day is this for?
  date: date('date').notNull(), 
  
  // Breakfast, Lunch, or Dinner?
  mealType: text('meal_type').notNull(), // 'breakfast', 'lunch', 'dinner'
  
  // Data from FatSecret (or your custom dish)
  foodName: text('food_name').notNull(),
  calories: real('calories').notNull(),
  protein: real('protein'),
  carbs: real('carbs'),
  fats: real('fats'),
  image: text('image'), // URL to the image
  
  createdAt: timestamp('created_at').defaultNow(),
});


// This table to store full custom recipes (Ingredients & Directions)
// which it will use at the recipe detail page
export const recipesTable = pgTable('recipes', {
  id: serial('id').primaryKey(),
  
  // Link to the user who saved it
  userId: integer('user_id').references(() => usersTable.userId).notNull(),
  
  // Core Info
  externalId: text('fatsecret_id'), 
  title: text('title').notNull(),
  image: text('image'),
  
  // Time & Servings
  prepTime: integer('prep_time_min').default(0),
  cookTime: integer('cook_time_min').default(0),
  servings: integer('servings').default(1),
  
  // Macros
  calories: real('calories').notNull(),
  protein: real('protein').default(0),
  carbs: real('carbs').default(0),
  fats: real('fats').default(0),
  
  // JSON COLUMNS (This matches your favorite.js logic)
  ingredients: json('ingredients').default([]), 
  instructions: json('instructions').default([]),
  
  createdAt: timestamp('created_at').defaultNow(),
});

// 1. SHOPPING LISTS (The container)
export const shoppingListsTable = pgTable('shopping_lists', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => usersTable.userId).notNull(),
  title: text('title').notNull(), // e.g., "Weekly Groceries" or "Fried Rice Ingredients"
  createdAt: timestamp('created_at').defaultNow(),
});

// 2. SHOPPING ITEMS (The ingredients inside a list)
export const shoppingItemsTable = pgTable('shopping_items', {
  id: serial('id').primaryKey(),
  listId: integer('list_id').references(() => shoppingListsTable.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(), // e.g., "2 eggs"
  isChecked: boolean('is_checked').default(false),
});

// CALORIE GOALS TABLE
export const calorieGoalsTable = pgTable('calorie_goals', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => usersTable.userId).notNull(),
  
  goalName: text('goal_name').notNull(), // "Summer Fitness Goal"
  dailyCalories: integer('daily_calories').notNull(), // 2000
  description: text('description'), // Optional notes
  
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  
  notificationsEnabled: boolean('notifications_enabled').default(false),
  
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});