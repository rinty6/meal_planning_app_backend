// This schema store food and recipe data for our meal app

import { pgTable, bigint, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// This table store names of branded food items
// There is no 2 same row value for food names 
export const catalogBrandsTable = pgTable('catalog_brands', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull(),
  websiteUrl: text('website_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  nameUniqueIdx: uniqueIndex('catalog_brands_name_unique').on(table.name),
  normalizedNameUniqueIdx: uniqueIndex('catalog_brands_normalized_name_unique').on(table.normalizedName),
}));