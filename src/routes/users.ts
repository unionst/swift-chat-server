import { Hono } from "hono";
import { upsertUser, userJson } from "../lib/chat.js";
import { db } from "../lib/db.js";
import { bodyOf, fail, httpsUrl, optionalText, textOf, userFrom, type Env } from "../lib/http.js";
import { issueToken, newId } from "../lib/secrets.js";

export const users = new Hono<Env>();

users.post("/users/anonymous", async (c) => {
  if (process.env.ALLOW_ANONYMOUS_USERS !== "1") {
    fail(403, "anonymous_disabled", "Anonymous sign-in is off. Set ALLOW_ANONYMOUS_USERS=1 on the server, or mint tokens from your backend with POST /admin/users.");
  }
  const body = await bodyOf(c);
  const user = await upsertUser({ externalId: `anon:${newId("", 12).slice(1)}`, name: textOf(body.name, 80) || null, avatarUrl: httpsUrl(body.avatar_url) });
  return c.json({ user: userJson(user), token: issueToken(user.id) });
});

users.get("/me", async (c) => {
  const user = await userFrom(c);
  return c.json({ user: userJson(user), event_seq: user.event_seq });
});

users.patch("/me", async (c) => {
  const user = await userFrom(c);
  const body = await bodyOf(c);
  const name = optionalText(body.name, 80);
  const avatar = body.avatar_url === undefined ? undefined : body.avatar_url === null ? null : httpsUrl(body.avatar_url);
  const row = await db.one(
    `UPDATE users SET
       name = CASE WHEN $2::boolean THEN $3 ELSE name END,
       avatar_url = CASE WHEN $4::boolean THEN $5 ELSE avatar_url END
     WHERE id = $1 RETURNING *`,
    [user.id, name !== undefined, name ?? null, avatar !== undefined, avatar ?? null],
  );
  return c.json({ user: userJson(row as any) });
});

users.get("/users", async (c) => {
  await userFrom(c);
  if (process.env.USER_DIRECTORY === "0") fail(403, "directory_disabled", "The user directory is off on this server.");
  const search = (c.req.query("q") ?? "").trim();
  const ids = (c.req.query("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean).slice(0, 100);
  const externalIds = (c.req.query("external_ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean).slice(0, 100);
  const rows = await db.query(
    `SELECT * FROM users
     WHERE ($1 = '' OR name ILIKE '%' || $1 || '%')
       AND (cardinality($2::text[]) = 0 OR id = ANY($2::text[]))
       AND (cardinality($3::text[]) = 0 OR external_id = ANY($3::text[]))
       AND (external_id NOT LIKE 'anon:%' OR id = ANY($2::text[]) OR external_id = ANY($3::text[]))
     ORDER BY name NULLS LAST, created_at LIMIT 50`,
    [search, ids, externalIds],
  );
  return c.json({ users: rows.map((row) => userJson(row as any)) });
});

users.post("/devices", async (c) => {
  const user = await userFrom(c);
  const body = await bodyOf(c);
  const token = typeof body.token === "string" && /^[0-9a-f]{32,200}$/i.test(body.token) ? body.token.toLowerCase() : null;
  if (!token) fail(400, "invalid_request", "A device token is required.");
  const environment = body.environment === "sandbox" ? "sandbox" : "production";
  await db.query(
    `INSERT INTO devices (token, user_id, environment) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, environment = EXCLUDED.environment, updated_at = now()`,
    [token, user.id, environment],
  );
  return c.json({ ok: true });
});

users.delete("/devices/:token", async (c) => {
  const user = await userFrom(c);
  await db.query("DELETE FROM devices WHERE token = $1 AND user_id = $2", [c.req.param("token").toLowerCase(), user.id]);
  return c.json({ ok: true });
});
