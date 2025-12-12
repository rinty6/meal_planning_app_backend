import { ENV } from "./src/config/env.js";


// This file sets up the Drizzle ORM configuration for database migrations
// Helps create and manage database schema changes
// run npx drizzle-kit generate:migration "migration_name" to create a new migration
export default {
    schema: "./src/db/schema.js",
    out: "./src/db/migrations",
    dialect: "postgresql",
    dbCredentials: {url: ENV.DB_URL},
}