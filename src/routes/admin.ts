import { waitUntil } from "@vercel/functions";
import { Hono } from "hono";
import {
  addMembers,
  conversationsFor,
  createConversation,
  markProgress,
  memberIds,
  messagesIn,
  postMessage,
  removeMember,
  setTyping,
  upsertUser,
  userJson,
  usersByExternalIds,
  usersByIds,
  type UserRow,
} from "../lib/chat.js";
import { db } from "../lib/db.js";
import { bodyOf, fail, httpsUrl, mediaOf, optionalText, requireAdmin, stringList, textOf, type Env } from "../lib/http.js";
import { pushMessage } from "../lib/push.js";
import { issueToken } from "../lib/secrets.js";
import { signalUsers } from "../lib/signal.js";

async function userByEither(id: unknown, externalId: unknown): Promise<UserRow | null> {
  if (typeof id === "string") return (await usersByIds([id]))[0] ?? null;
  if (typeof externalId === "string") return (await usersByExternalIds([externalId]))[0] ?? null;
  return null;
}

async function resolveMembers(body: Record<string, any>): Promise<string[]> {
  const ids = stringList(body.member_ids);
  const external = stringList(body.member_external_ids);
  const fromExternal = (await usersByExternalIds(external)).map((user) => user.id);
  if (fromExternal.length !== external.length) fail(404, "user_not_found", "One of those external_ids hasn’t been created yet.");
  return [...new Set([...ids, ...fromExternal])];
}

export const admin = new Hono<Env>();

admin.use("*", async (c, next) => {
  requireAdmin(c);
  await next();
});

admin.post("/users", async (c) => {
  const body = await bodyOf(c);
  const externalId = textOf(body.external_id, 200);
  if (!externalId) fail(400, "invalid_request", "external_id is required: your own id for this user.");
  const user = await upsertUser({ externalId, name: optionalText(body.name, 80) ?? null, avatarUrl: httpsUrl(body.avatar_url) });
  const lifetime = Number(body.token_lifetime_seconds);
  return c.json({ user: userJson(user), token: issueToken(user.id, Number.isFinite(lifetime) && lifetime > 0 ? lifetime : undefined) });
});

admin.post("/users/:id/token", async (c) => {
  const user = (await usersByIds([c.req.param("id")]))[0];
  if (!user) fail(404, "user_not_found", "No user with that id.");
  const lifetime = Number((await bodyOf(c)).token_lifetime_seconds);
  return c.json({ token: issueToken(user.id, Number.isFinite(lifetime) && lifetime > 0 ? lifetime : undefined) });
});

admin.get("/users/:id", async (c) => {
  const id = c.req.param("id");
  const user = (await usersByIds([id]))[0] ?? (await usersByExternalIds([id]))[0];
  if (!user) fail(404, "user_not_found", "No user with that id.");
  return c.json({ user: userJson(user) });
});

admin.delete("/users/:id", async (c) => {
  const id = c.req.param("id");
  const user = (await usersByIds([id]))[0] ?? (await usersByExternalIds([id]))[0];
  if (!user) fail(404, "user_not_found", "No user with that id.");
  const rows = await db.query<{ conversation_id: string }>("SELECT conversation_id FROM participants WHERE user_id = $1", [user.id]);
  for (const row of rows) {
    const result = await removeMember(row.conversation_id, user.id);
    waitUntil(signalUsers(result.remaining));
  }
  await db.query("DELETE FROM users WHERE id = $1", [user.id]);
  return c.json({ ok: true });
});

admin.post("/conversations", async (c) => {
  const body = await bodyOf(c);
  const members = await resolveMembers(body);
  if (members.length < 2) fail(400, "invalid_request", "A conversation needs at least two members.");
  const created = await createConversation({ creatorId: members[0], memberIds: members, name: optionalText(body.name, 120) ?? null, photoUrl: httpsUrl(body.photo_url) });
  if (!created) fail(404, "user_not_found", "One of those users doesn’t exist.");
  if (created.created) waitUntil(signalUsers(created.members));
  return c.json({ conversation: created.conversation, created: created.created });
});

admin.get("/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const members = await memberIds(id);
  if (members.length === 0) fail(404, "conversation_not_found", "No conversation with that id.");
  const [conversation] = await conversationsFor(members[0], id);
  return c.json({ conversation });
});

admin.post("/conversations/:id/members", async (c) => {
  const id = c.req.param("id");
  const members = await resolveMembers(await bodyOf(c));
  const all = await addMembers(id, members);
  if (!all) fail(404, "conversation_not_found", "No conversation with that id.");
  waitUntil(signalUsers(all));
  return c.json({ member_ids: all });
});

admin.delete("/conversations/:id/members/:userId", async (c) => {
  const result = await removeMember(c.req.param("id"), c.req.param("userId"));
  waitUntil(signalUsers([...result.remaining, c.req.param("userId")]));
  return c.json({ ok: true, member_ids: result.remaining });
});

admin.get("/conversations/:id/messages", async (c) => {
  const after = Number(c.req.query("after_seq"));
  const before = Number(c.req.query("before_seq"));
  const limit = Number(c.req.query("limit"));
  const page = await messagesIn(c.req.param("id"), {
    afterSeq: c.req.query("after_seq") !== undefined && Number.isFinite(after) ? after : undefined,
    beforeSeq: c.req.query("before_seq") !== undefined && Number.isFinite(before) ? before : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
  return c.json({ messages: page.messages, has_more: page.hasMore });
});

admin.post("/conversations/:id/messages", async (c) => {
  const id = c.req.param("id");
  const body = await bodyOf(c);
  const sender = await userByEither(body.sender_id, body.sender_external_id);
  if ((body.sender_id !== undefined || body.sender_external_id !== undefined) && !sender) fail(404, "user_not_found", "No such sender.");
  const text = textOf(body.text, 8_000);
  const media = mediaOf(body.media, "any");
  if (!text && media.length === 0) fail(400, "empty_message", "A message needs text or an attachment.");
  const clientId = typeof body.client_id === "string" ? body.client_id.slice(0, 64) : null;
  const posted = await postMessage({ conversationId: id, senderId: sender?.id ?? null, text, media, clientId });
  if (!posted) fail(404, "conversation_not_found", "No conversation with that id.");
  if (posted.fresh) {
    waitUntil(signalUsers(posted.members));
    waitUntil(pushMessage(posted).catch((error) => console.error("push failed:", (error as Error).message)));
  }
  return c.json({ message: posted.message });
});

admin.post("/conversations/:id/typing", async (c) => {
  const body = await bodyOf(c);
  const user = await userByEither(body.user_id, body.user_external_id);
  if (!user) fail(404, "user_not_found", "Pass user_id or user_external_id.");
  await setTyping(c.req.param("id"), user.id, body.typing !== false);
  return c.json({ ok: true });
});

admin.post("/conversations/:id/read", async (c) => {
  const body = await bodyOf(c);
  const user = await userByEither(body.user_id, body.user_external_id);
  if (!user) fail(404, "user_not_found", "Pass user_id or user_external_id.");
  const seq = Number(body.seq);
  if (!Number.isFinite(seq) || seq < 0) fail(400, "invalid_request", "seq is required.");
  const receipt = await markProgress(c.req.param("id"), user.id, { read: seq });
  if (receipt) waitUntil(signalUsers(receipt.members));
  return c.json({ ok: true });
});
