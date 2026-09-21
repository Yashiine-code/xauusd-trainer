#!/usr/bin/env node

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for migrations.");
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  console.info("Tracked database migrations applied.");
} finally {
  await sql.end({ timeout: 5 });
}
