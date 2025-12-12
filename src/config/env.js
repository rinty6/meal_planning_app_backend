import dotenv from 'dotenv';

// Load environment variables from .env file including all key-value pairs
dotenv.config();

export const ENV = {
  PORT: process.env.PORT || 5000,
  DB_URL: process.env.DB_URL,
  NODE_ENV: process.env.NODE_ENV || 'development',
};