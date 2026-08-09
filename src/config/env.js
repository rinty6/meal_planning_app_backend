import dotenv from 'dotenv';

// Load environment variables from .env file including all key-value pairs
dotenv.config();

export const ENV = {
  PORT: process.env.PORT || 5000,
  DB_URL: process.env.DB_URL,
  NODE_ENV: process.env.NODE_ENV || 'development',
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY || '',
  EMAIL_USER: process.env.EMAIL_USER || '',
  EMAIL_PASSWORD: process.env.EMAIL_PASSWORD || '',
  FEEDBACK_TO_EMAIL: process.env.FEEDBACK_TO_EMAIL || '',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  FEEDBACK_FROM_EMAIL: process.env.FEEDBACK_FROM_EMAIL || '',
  FOOD_RECOGNITION_API_URL: process.env.FOOD_RECOGNITION_API_URL || '',
  FOOD_RECOGNITION_API_TOKEN: process.env.FOOD_RECOGNITION_API_TOKEN || '',
  // Cloudinary hosts user-uploaded recipe photos (recipesTable.image only ever stores a URL).
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || '',
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || '',
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || '',
  // TheMealDB premier key for recipe browse-by-cuisine. Falls back to the public
  // test key "1" for local dev (limited catalog).
  MEALDB_API_KEY: process.env.MEALDB_API_KEY || '1',
  // Shared secret that protects the manual notification trigger
  // (POST /api/internal/run-reminders). When empty, the endpoint is disabled.
  INTERNAL_TRIGGER_SECRET: process.env.INTERNAL_TRIGGER_SECRET || '',
  // Absolute origin this service is reachable at, used to build public asset
  // URLs that leave the building — currently the Pip artwork attached to push
  // notifications, which the phone's OS fetches for itself and therefore cannot
  // be given a relative path. Railway injects RAILWAY_PUBLIC_DOMAIN, so this
  // needs no manual configuration in production. Empty locally, which makes
  // getPipImageUrl() return null and pushes fall back to text-only.
  PUBLIC_BASE_URL: (
    process.env.PUBLIC_BASE_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
  ).replace(/\/+$/, ''),
};
