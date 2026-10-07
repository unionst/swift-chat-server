import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Media, UserRow } from "./chat.js";
import { db } from "./db.js";
import { isServerSecret, readToken } from "./secrets.js";

export type Env = { Variables: { user: UserRow } };

export function fail(status: ContentfulStatusCode, code: string, message: string): never {
  throw new HTTPException(status, { res: Response.json({ error: message, code }, { status }) });
}

export function bearer(c: Context): string | null {
  const header = c.req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

export async function userFrom(c: Context): Promise<UserRow> {
  const userId = readToken(bearer(c));
  if (!userId) fail(401, "unauthorized", "This token isn’t valid. Mint a new one for the user.");
  const user = await db.one<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
  if (!user) fail(401, "unauthorized", "This user no longer exists.");
  return user;
}

export function requireAdmin(c: Context): void {
  if (!isServerSecret(bearer(c))) fail(401, "unauthorized", "Admin routes take the server secret as Authorization: Bearer <SWIFT_CHAT_SECRET>.");
}

export async function bodyOf(c: Context): Promise<Record<string, any>> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function textOf(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = textOf(value, max);
  return text || null;
}

export function stringList(value: unknown, max = 100): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200))].slice(0, max);
}

export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function mediaOf(value: unknown, hosts: "any" | "ours"): Media[] {
  if (!Array.isArray(value)) return [];
  const allowExternal = hosts === "any" || process.env.ALLOW_EXTERNAL_MEDIA === "1";
  const out: Media[] = [];
  for (const item of value.slice(0, 10)) {
    const url = httpsUrl(typeof item === "string" ? item : item?.url);
    if (!url) continue;
    if (!allowExternal && !new URL(url).hostname.endsWith(".public.blob.vercel-storage.com")) continue;
    const width = Number(item?.width);
    const height = Number(item?.height);
    const kind = item?.kind === "file" ? "file" : "image";
    const name = typeof item?.name === "string" ? item.name.slice(0, 200) : undefined;
    const size = Number(item?.size);
    out.push({
      url,
      kind,
      ...(name ? { name } : {}),
      ...(Number.isFinite(size) && size > 0 ? { size: Math.round(size) } : {}),
      ...(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? { width: Math.round(width), height: Math.round(height) } : {}),
    });
  }
  return out;
}
