import pg from "pg";
import { db, directUrl } from "./db.js";

const CHANNEL = "swift_chat";

export interface Passing {
  type: string;
  [key: string]: unknown;
}

type Listener = (passing: Passing | null) => void;

const listeners = new Map<string, Set<Listener>>();
let client: pg.Client | null = null;
let connecting: Promise<void> | null = null;

function drop(gone: pg.Client): void {
  if (client === gone) client = null;
  gone.removeAllListeners();
  gone.end().catch(() => {});
}

async function connect(): Promise<void> {
  const next = new pg.Client({ connectionString: directUrl(), keepAlive: true });
  next.on("notification", (notification) => {
    if (!notification.payload) return;
    let parsed: { k?: string; e?: Passing | null };
    try {
      parsed = JSON.parse(notification.payload);
    } catch {
      return;
    }
    if (!parsed.k) return;
    for (const listener of listeners.get(parsed.k) ?? []) listener(parsed.e ?? null);
  });
  next.on("error", () => drop(next));
  next.on("end", () => drop(next));
  await next.connect();
  await next.query(`LISTEN ${CHANNEL}`);
  client = next;
}

export function listening(): Promise<void> {
  if (client) return Promise.resolve();
  connecting ??= connect()
    .catch((error) => console.error("could not listen for signals:", (error as Error).message))
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

export function subscribe(key: string, listener: Listener): () => void {
  const set = listeners.get(key) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(key, set);
  void listening();
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
    if (listeners.size === 0 && client) drop(client);
  };
}

export async function signal(key: string, passing: Passing | null = null): Promise<void> {
  try {
    await db.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ k: key, e: passing })]);
  } catch (error) {
    console.error("signal failed:", (error as Error).message);
  }
}

export async function signalUsers(userIds: string[], passing: Passing | null = null): Promise<void> {
  await Promise.all([...new Set(userIds)].map((userId) => signal(userKey(userId), passing)));
}

export const userKey = (userId: string) => `u:${userId}`;

export interface Waiter {
  next(timeoutMs: number): Promise<{ durable: boolean; passing: Passing[] }>;
  close(): void;
}

export function waiterFor(key: string): Waiter {
  let durable = false;
  let passing: Passing[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const unsubscribe = subscribe(key, (event) => {
    if (event) passing.push(event);
    else durable = true;
    wake?.();
  });
  return {
    async next(timeoutMs) {
      await listening();
      if (!durable && passing.length === 0 && !closed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
      const result = { durable, passing };
      durable = false;
      passing = [];
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      wake?.();
    },
  };
}
