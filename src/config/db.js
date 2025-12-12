import { drizzle } from "drizzle-orm/neon-http";
import {neon} from "@neondatabase/serverless"
import {ENV} from "./env.js";
import * as schema from "../db/schema.js";

// Create a Drizzle ORM database instance using Neon and the provided DB_URL from environment variables
const sql = neon(ENV.DB_URL);
export const db = drizzle(sql, {schema});