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
  FEEDBACK_TO_EMAIL: process.env.FEEDBACK_TO_EMAIL || 'duongphuthinh2001@gmail.com',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  FEEDBACK_FROM_EMAIL: process.env.FEEDBACK_FROM_EMAIL || '',
  FOOD_RECOGNITION_API_URL: process.env.FOOD_RECOGNITION_API_URL || '',
  FOOD_RECOGNITION_API_TOKEN: process.env.FOOD_RECOGNITION_API_TOKEN || '',
  // Shared secret that protects the manual notification trigger
  // (POST /api/internal/run-reminders). When empty, the endpoint is disabled.
  INTERNAL_TRIGGER_SECRET: process.env.INTERNAL_TRIGGER_SECRET || '',
};
