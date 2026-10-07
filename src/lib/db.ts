import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";

pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export type Row = Record<string, any>;

export interface Querier {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row = Row>(text: string, params?: unknown[]): Promise<T | null>;
}

let pool: pg.Pool | null = null;

export function pooledUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

export function directUrl(): string {
  return process.env.DATABASE_URL_UNPOOLED ?? process.env.POSTGRES_URL_NON_POOLING ?? pooledUrl();
}

function connections(): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({ connectionString: pooledUrl(), max: 6, idleTimeoutMillis: 5_000, connectionTimeoutMillis: 10_000 });
  pool.on("error", (error) => console.error("idle database connection failed:", error.message));
  attachDatabasePool(pool);
  return pool;
}

function over(runner: { query: (text: string, params?: any[]) => Promise<pg.QueryResult> }): Querier {
  return {
    async query<T extends Row = Row>(text: string, params: unknown[] = []) {
      const result = await runner.query(text, params as any[]);
      return result.rows as T[];
    },
    async one<T extends Row = Row>(text: string, params: unknown[] = []) {
      const result = await runner.query(text, params as any[]);
      return (result.rows[0] as T | undefined) ?? null;
    },
  };
}

export const db: Querier = {
  query: (text, params) => over(connections()).query(text, params),
  one: (text, params) => over(connections()).one(text, params),
};

export async function transaction<T>(work: (tx: Querier) => Promise<T>): Promise<T> {
  const client = await connections().connect();
  try {
    await client.query("BEGIN");
    const result = await work(over(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
