import { waitUntil } from "@vercel/functions";
import { Hono } from "hono";
import {
  addMembers,
  conversationsFor,
  createConversation,
  markProgress,
  membership,
  messagesIn,
  postMessage,
  removeMember,
  setMuted,
  setReaction,
  setTyping,
  updateConversation,
  usersByExternalIds,
  type ParticipantRow,
} from "../lib/chat.js";
import { db } from "../lib/db.js";
import { bodyOf, fail, httpsUrl, mediaOf, optionalText, stringList, textOf, userFrom, type Env } from "../lib/http.js";
import { pushMessage } from "../lib/push.js";
import { signalUsers } from "../lib/signal.js";

async function joined(conversationId: string, userId: string): Promise<ParticipantRow> {
  const row = await membership(conversationId, userId);
  if (!row) fail(404, "conversation_not_found", "You’re not in that conversation.");
  return row;
}

async function resolveMembers(body: Record<string, any>): Promise<string[]> {
  const ids = stringList(body.member_ids);
  const external = stringList(body.member_external_ids);
  const fromExternal = (await usersByExternalIds(external)).map((user) => user.id);
  if (fromExternal.length !== external.length) fail(404, "user_not_found", "One of those users hasn’t been created yet.");
  return [...new Set([...ids, ...fromExternal])];
}

export const conversations = new Hono<Env>();

conversations.get("/conversations", async (c) => {
  const user = await userFrom(c);
  const fresh = await db.one<{ event_seq: number }>("SELECT event_seq FROM users WHERE id = $1", [user.id]);
  return c.json({ event_seq: fresh?.event_seq ?? user.event_seq, conversations: await conversationsFor(user.id) });
});

conversations.post("/conversations", async (c) => {
  const user = await userFrom(c);
  const body = await bodyOf(c);
  const members = await resolveMembers(body);
  if (members.filter((id) => id !== user.id).length === 0) fail(400, "invalid_request", "A conversation needs at least one other person: pass member_ids or member_external_ids.");
  const created = await createConversation({ creatorId: user.id, memberIds: members, name: optionalText(body.name, 120) ?? null, photoUrl: httpsUrl(body.photo_url) });
  if (!created) fail(404, "user_not_found", "One of those users doesn’t exist.");
  if (created.created) waitUntil(signalUsers(created.members));
  return c.json({ conversation: created.conversation, created: created.created });
});

conversations.get("/conversations/:id", async (c) => {
  const user = await userFrom(c);
  await joined(c.req.param("id"), user.id);
  const [conversation] = await conversationsFor(user.id, c.req.param("id"));
  return c.json({ conversation });
});

conversations.patch("/conversations/:id", async (c) => {
  const user = await userFrom(c);
  const id = c.req.param("id");
  await joined(id, user.id);
  const body = await bodyOf(c);
  if (typeof body.muted === "boolean") await setMuted(id, user.id, body.muted);
  const name = optionalText(body.name, 120);
  const photo = body.photo_url === undefined ? undefined : body.photo_url === null ? null : httpsUrl(body.photo_url);
  if (name !== undefined || photo !== undefined) {
    const members = await updateConversation(id, { name, photoUrl: photo });
    if (members) waitUntil(signalUsers(members));
  }
  const [conversation] = await conversationsFor(user.id, id);
  return c.json({ conversation });
});

conversations.post("/conversations/:id/members", async (c) => {
  const user = await userFrom(c);
  const id = c.req.param("id");
  await joined(id, user.id);
  const members = await resolveMembers(await bodyOf(c));
  if (members.length === 0) fail(400, "invalid_request", "Pass member_ids or member_external_ids.");
  const all = await addMembers(id, members);
  if (!all) fail(404, "conversation_not_found", "That conversation is gone.");
  waitUntil(signalUsers(all));
  const [conversation] = await conversationsFor(user.id, id);
  return c.json({ conversation });
});

conversations.delete("/conversations/:id/members/:userId", async (c) => {
  const user = await userFrom(c);
  const id = c.req.param("id");
  await joined(id, user.id);
  const target = c.req.param("userId") === "me" ? user.id : c.req.param("userId");
  const result = await removeMember(id, target);
  waitUntil(signalUsers([...result.remaining, target]));
  return c.json({ ok: true });
});

conversations.delete("/conversations/:id", async (c) => {
  const user = await userFrom(c);
  const id = c.req.param("id");
  await joined(id, user.id);
  const result = await removeMember(id, user.id);
  waitUntil(signalUsers([...result.remaining, user.id]));
  return c.json({ ok: true });
});

conversations.get("/conversations/:id/messages", async (c) => {
  const user = await userFrom(c);
  const id = c.req.param("id");
  await joined(id, user.id);
  const after = Number(c.req.query("after_seq"));
  const before = Number(c.req.query("before_seq"));
  const limit = Number(c.req.query("limit"));
  const page = await messagesIn(id, {
    afterSeq: c.req.query("after_seq") !== undefined && Number.isFinite(after) ? after : undefined,
    beforeSeq: c.req.query("before_seq") !== undefined && Number.isFinite(before) ? before : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
  const [conversation] = await conversationsFor(user.id, id);
  return c.json({ messages: page.messages, has_more: page.hasMore, conversation });
});

conversations.post("/conversations/:id/messages", async (c) => {
  const user = await userFrom(c);
  const id = c.req.param("id");
  await joined(id, user.id);
  const body = await bodyOf(c);
  const text = textOf(body.text, 8_000);
  const media = mediaOf(body.media, "ours");
  if (!text && media.length === 0) fail(400, "empty_message", "A message needs text or an attachment.");
  const clientId = typeof body.client_id === "string" ? body.client_id.slice(0, 64) : null;
  const posted = await postMessage({ conversationId: id, senderId: user.id, text, media, clientId });
  if (!posted) fail(404, "conversation_not_found", "That conversation is gone.");
  if (posted.fresh) {
    waitUntil(signalUsers(posted.members));
    waitUntil(pushMessage(posted).catch((error) => console.error("push failed:", (error as Error).message)));
  }
  const [conversation] = await conversationsFor(user.id, id);
  return c.json({ message: posted.message, conversation });
});

conversations.post("/conversations/:id/read", async (c) => {
  const user = await userFrom(c);
  const id = c.req.param("id");
  await joined(id, user.id);
  const seq = Number((await bodyOf(c)).seq);
  if (!Number.isFinite(seq) || seq < 0) fail(400, "invalid_request", "seq is required.");
  const receipt = await markProgress(id, user.id, { read: seq });
  if (receipt) waitUntil(signalUsers(receipt.members));
  return c.json({ ok: true });
});

conversations.post("/conversations/:id/delivered", async (c) => {
  const user = await userFrom(c);
  const id = c.req.param("id");
  await joined(id, user.id);
  const seq = Number((await bodyOf(c)).seq);
  if (!Number.isFinite(seq) || seq < 0) fail(400, "invalid_request", "seq is required.");
  const receipt = await markProgress(id, user.id, { delivered: seq });
  if (receipt) waitUntil(signalUsers(receipt.members));
  return c.json({ ok: true });
});

conversations.post("/conversations/:id/typing", async (c) => {
  const user = await userFrom(c);
  const id = c.req.param("id");
  await joined(id, user.id);
  const typing = (await bodyOf(c)).typing !== false;
  await setTyping(id, user.id, typing);
  return c.json({ ok: true });
});

conversations.put("/conversations/:id/messages/:messageId/reaction", async (c) => {
  const user = await userFrom(c);
  const id = c.req.param("id");
  await joined(id, user.id);
  const body = await bodyOf(c);
  const emoji = typeof body.emoji === "string" && body.emoji.trim() ? body.emoji.trim().slice(0, 16) : null;
  const part = body.part === "media" ? "media" : "message";
  const reacted = await setReaction({ conversationId: id, messageId: c.req.param("messageId"), userId: user.id, emoji, part });
  if (!reacted) fail(404, "message_not_found", "That message is gone.");
  waitUntil(signalUsers(reacted.members));
  return c.json({ message_id: reacted.message_id, reactions: reacted.reactions });
});
