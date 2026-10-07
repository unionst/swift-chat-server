import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

function databaseUrl() {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) return url;
  try {
    const file = readFileSync(join(here, "..", ".env.local"), "utf8");
    for (const key of ["DATABASE_URL_UNPOOLED", "DATABASE_URL"]) {
      const line = file.split("\n").find((entry) => entry.startsWith(`${key}=`));
      if (line) return line.slice(key.length + 1).trim().replace(/^"|"$/g, "");
    }
  } catch {}
  return null;
}

const url = databaseUrl();
if (!url) {
  console.log("DATABASE_URL is not set, so the schema was not applied. Add a Postgres store to the project and redeploy.");
  process.exit(0);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(readFileSync(join(here, "schema.sql"), "utf8"));
const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1");
console.log(`schema applied: ${tables.rows.map((row) => row.tablename).join(", ")}`);
await client.end();
