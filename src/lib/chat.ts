import { db, transaction, type Querier } from "./db.js";
import { newId } from "./secrets.js";
import { signalUsers } from "./signal.js";

export interface Media {
  url: string;
  kind: "image" | "file";
  name?: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface UserRow {
  id: string;
  external_id: string;
  name: string | null;
  avatar_url: string | null;
  event_seq: number;
  created_at: Date;
}

export interface UserJson {
  id: string;
  external_id: string;
  name: string | null;
  avatar_url: string | null;
}

export interface ConversationRow {
  id: string;
  name: string | null;
  photo_url: string | null;
  direct_key: string | null;
  created_by: string | null;
  last_seq: number;
  last_message_at: Date | string;
  created_at: Date | string;
}

export interface ParticipantRow {
  conversation_id: string;
  user_id: string;
  read_seq: number;
  delivered_seq: number;
  typing_until: Date | string | null;
  muted: boolean;
  joined_at: Date | string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  sender_id: string | null;
  text: string;
  media: Media[];
  client_id: string | null;
  created_at: Date | string;
}

export interface ReactionJson {
  user_id: string;
  emoji: string;
  part: "message" | "media";
}

export interface MessageJson {
  id: string;
  conversation_id: string;
  seq: number;
  sender_id: string | null;
  text: string;
  media: Media[];
  client_id: string | null;
  created_at: string;
  reactions: ReactionJson[];
}

export interface ParticipantJson {
  user: UserJson;
  read_seq: number;
  delivered_seq: number;
  typing: boolean;
  joined_at: string;
}

export interface ConversationJson {
  id: string;
  name: string | null;
  photo_url: string | null;
  direct: boolean;
  created_at: string;
  last_seq: number;
  last_message_at: string;
  last_message: MessageJson | null;
  unread: number;
  me: { read_seq: number; delivered_seq: number; muted: boolean };
  participants: ParticipantJson[];
}

export interface Receipt {
  conversation_id: string;
  user_id: string;
  delivered_seq: number;
  read_seq: number;
}

const iso = (value: Date | string) => new Date(value).toISOString();
const future = (value: Date | string | null) => value !== null && new Date(value).getTime() > Date.now();

export function userJson(row: UserRow | UserJson): UserJson {
  return { id: row.id, external_id: row.external_id, name: row.name, avatar_url: row.avatar_url };
}

export function messageJson(row: MessageRow, reactions: ReactionJson[] = []): MessageJson {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    seq: row.seq,
    sender_id: row.sender_id,
    text: row.text,
    media: row.media ?? [],
    client_id: row.client_id,
    created_at: iso(row.created_at),
    reactions,
  };
}

export async function appendEvents(tx: Querier, userIds: string[], type: string, payload: unknown): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  await tx.query(
    `WITH bumped AS (
       UPDATE users SET event_seq = event_seq + 1 WHERE id = ANY($1::text[]) RETURNING id, event_seq
     )
     INSERT INTO user_events (user_id, seq, type, payload)
     SELECT id, event_seq, $2, $3::jsonb FROM bumped`,
    [unique, type, JSON.stringify(payload)],
  );
}

export async function memberIds(conversationId: string, tx: Querier = db): Promise<string[]> {
  const rows = await tx.query<{ user_id: string }>("SELECT user_id FROM participants WHERE conversation_id = $1", [conversationId]);
  return rows.map((row) => row.user_id);
}

export async function membership(conversationId: string, userId: string, tx: Querier = db): Promise<ParticipantRow | null> {
  return tx.one<ParticipantRow>("SELECT * FROM participants WHERE conversation_id = $1 AND user_id = $2", [conversationId, userId]);
}

export async function conversationsFor(userId: string, onlyId: string | null = null, tx: Querier = db): Promise<ConversationJson[]> {
  const rows = await tx.query(
    `SELECT to_jsonb(c) AS conversation, to_jsonb(me) AS me,
            (SELECT jsonb_agg(jsonb_build_object(
               'user', jsonb_build_object('id', u.id, 'external_id', u.external_id, 'name', u.name, 'avatar_url', u.avatar_url),
               'read_seq', p.read_seq, 'delivered_seq', p.delivered_seq,
               'typing', p.typing_until IS NOT NULL AND p.typing_until > now(),
               'joined_at', p.joined_at
             ) ORDER BY p.joined_at)
             FROM participants p JOIN users u ON u.id = p.user_id WHERE p.conversation_id = c.id) AS participants,
            (SELECT to_jsonb(m) FROM messages m WHERE m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1) AS last_message,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.seq > me.read_seq AND m.sender_id IS DISTINCT FROM $1) AS unread
     FROM participants me JOIN conversations c ON c.id = me.conversation_id
     WHERE me.user_id = $1 AND ($2::text IS NULL OR c.id = $2)
     ORDER BY c.last_message_at DESC`,
    [userId, onlyId],
  );
  return rows.map((row) => conversationJson(row.conversation, row.me, row.participants ?? [], row.last_message, row.unread));
}

function conversationJson(
  conversation: ConversationRow,
  me: ParticipantRow,
  participants: Array<Omit<ParticipantJson, "joined_at"> & { joined_at: string }>,
  lastMessage: MessageRow | null,
  unread: number,
): ConversationJson {
  return {
    id: conversation.id,
    name: conversation.name,
    photo_url: conversation.photo_url,
    direct: conversation.direct_key !== null,
    created_at: iso(conversation.created_at),
    last_seq: conversation.last_seq,
    last_message_at: iso(conversation.last_message_at),
    last_message: lastMessage ? messageJson(lastMessage) : null,
    unread,
    me: { read_seq: me.read_seq, delivered_seq: me.delivered_seq, muted: me.muted },
    participants: participants.map((participant) => ({ ...participant, joined_at: iso(participant.joined_at) })),
  };
}

export async function usersByIds(ids: string[], tx: Querier = db): Promise<UserRow[]> {
  if (ids.length === 0) return [];
  return tx.query<UserRow>("SELECT * FROM users WHERE id = ANY($1::text[])", [ids]);
}

export async function usersByExternalIds(externalIds: string[], tx: Querier = db): Promise<UserRow[]> {
  if (externalIds.length === 0) return [];
  return tx.query<UserRow>("SELECT * FROM users WHERE external_id = ANY($1::text[])", [externalIds]);
}

export async function upsertUser(input: { externalId: string; name?: string | null; avatarUrl?: string | null }): Promise<UserRow> {
  const row = await db.one<UserRow>(
    `INSERT INTO users (id, external_id, name, avatar_url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (external_id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, users.name),
       avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url)
     RETURNING *`,
    [newId("usr"), input.externalId, input.name ?? null, input.avatarUrl ?? null],
  );
  if (!row) throw new Error("user was not stored");
  return row;
}

export interface Created {
  conversation: ConversationJson;
  created: boolean;
  members: string[];
}

export async function createConversation(input: { creatorId: string; memberIds: string[]; name?: string | null; photoUrl?: string | null }): Promise<Created | null> {
  const members = [...new Set([input.creatorId, ...input.memberIds])];
  const direct = !input.name && members.length === 2;
  const directKey = direct ? [...members].sort().join(":") : null;
  return transaction(async (tx) => {
    const known = await usersByIds(members, tx);
    if (known.length !== members.length) return null;
    if (directKey) {
      const existing = await tx.one<{ id: string }>("SELECT id FROM conversations WHERE direct_key = $1", [directKey]);
      if (existing) {
        const [conversation] = await conversationsFor(input.creatorId, existing.id, tx);
        return { conversation, created: false, members };
      }
    }
    const id = newId("cnv");
    await tx.query(
      "INSERT INTO conversations (id, name, photo_url, direct_key, created_by) VALUES ($1, $2, $3, $4, $5)",
      [id, input.name ?? null, input.photoUrl ?? null, directKey, input.creatorId],
    );
    await tx.query(
      "INSERT INTO participants (conversation_id, user_id) SELECT $1, unnest($2::text[])",
      [id, members],
    );
    await appendEvents(tx, members, "conversation_updated", { conversation_id: id });
    const [conversation] = await conversationsFor(input.creatorId, id, tx);
    return { conversation, created: true, members };
  });
}

export async function addMembers(conversationId: string, userIds: string[]): Promise<string[] | null> {
  return transaction(async (tx) => {
    const conversation = await tx.one<ConversationRow>("SELECT * FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
    if (!conversation) return null;
    const known = await usersByIds(userIds, tx);
    if (known.length === 0) return await memberIds(conversationId, tx);
    await tx.query(
      `INSERT INTO participants (conversation_id, user_id, read_seq, delivered_seq)
       SELECT $1, unnest($2::text[]), $3, $3 ON CONFLICT DO NOTHING`,
      [conversationId, known.map((user) => user.id), conversation.last_seq],
    );
    if (conversation.direct_key) await tx.query("UPDATE conversations SET direct_key = NULL WHERE id = $1", [conversationId]);
    const members = await memberIds(conversationId, tx);
    await appendEvents(tx, members, "conversation_updated", { conversation_id: conversationId });
    return members;
  });
}

export async function removeMember(conversationId: string, userId: string): Promise<{ remaining: string[]; removed: boolean }> {
  return transaction(async (tx) => {
    const gone = await tx.one("DELETE FROM participants WHERE conversation_id = $1 AND user_id = $2 RETURNING user_id", [conversationId, userId]);
    if (!gone) return { remaining: await memberIds(conversationId, tx), removed: false };
    await tx.query("UPDATE conversations SET direct_key = NULL WHERE id = $1 AND direct_key IS NOT NULL", [conversationId]);
    const remaining = await memberIds(conversationId, tx);
    if (remaining.length === 0) await tx.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
    await appendEvents(tx, [userId], "conversation_removed", { conversation_id: conversationId });
    await appendEvents(tx, remaining, "conversation_updated", { conversation_id: conversationId });
    return { remaining, removed: true };
  });
}

export async function updateConversation(conversationId: string, patch: { name?: string | null; photoUrl?: string | null }): Promise<string[] | null> {
  return transaction(async (tx) => {
    const row = await tx.one<ConversationRow>(
      `UPDATE conversations SET
         name = CASE WHEN $2::boolean THEN $3 ELSE name END,
         photo_url = CASE WHEN $4::boolean THEN $5 ELSE photo_url END,
         direct_key = CASE WHEN $2::boolean AND $3 IS NOT NULL THEN NULL ELSE direct_key END
       WHERE id = $1 RETURNING *`,
      [conversationId, patch.name !== undefined, patch.name ?? null, patch.photoUrl !== undefined, patch.photoUrl ?? null],
    );
    if (!row) return null;
    const members = await memberIds(conversationId, tx);
    await appendEvents(tx, members, "conversation_updated", { conversation_id: conversationId });
    return members;
  });
}

export interface Posted {
  message: MessageJson;
  conversation: ConversationRow;
  sender: UserRow | null;
  members: string[];
  fresh: boolean;
}

export async function postMessage(input: { conversationId: string; senderId: string | null; text: string; media?: Media[]; clientId?: string | null }): Promise<Posted | null> {
  return transaction(async (tx) => {
    const locked = await tx.one<ConversationRow>("SELECT * FROM conversations WHERE id = $1 FOR UPDATE", [input.conversationId]);
    if (!locked) return null;
    const members = await memberIds(input.conversationId, tx);
    const sender = input.senderId ? ((await usersByIds([input.senderId], tx))[0] ?? null) : null;

    if (input.clientId) {
      const existing = await tx.one<MessageRow>(
        "SELECT * FROM messages WHERE conversation_id = $1 AND client_id = $2",
        [input.conversationId, input.clientId],
      );
      if (existing) return { message: messageJson(existing), conversation: locked, sender, members, fresh: false };
    }

    const conversation = await tx.one<ConversationRow>(
      "UPDATE conversations SET last_seq = last_seq + 1, last_message_at = now() WHERE id = $1 RETURNING *",
      [input.conversationId],
    );
    if (!conversation) return null;
    const row = await tx.one<MessageRow>(
      `INSERT INTO messages (id, conversation_id, seq, sender_id, text, media, client_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *`,
      [newId("msg"), conversation.id, conversation.last_seq, input.senderId, input.text, JSON.stringify(input.media ?? []), input.clientId ?? null],
    );
    if (!row) throw new Error("message was not stored");
    if (input.senderId) {
      await tx.query(
        `UPDATE participants SET read_seq = $3, delivered_seq = $3, typing_until = NULL
         WHERE conversation_id = $1 AND user_id = $2`,
        [conversation.id, input.senderId, conversation.last_seq],
      );
    }
    const message = messageJson(row);
    await appendEvents(tx, members, "message", { conversation_id: conversation.id, message });
    return { message, conversation, sender, members, fresh: true };
  });
}

export async function markProgress(conversationId: string, userId: string, progress: { delivered?: number; read?: number }): Promise<(Receipt & { members: string[] }) | null> {
  const delivered = Math.max(progress.delivered ?? 0, progress.read ?? 0);
  const read = progress.read ?? 0;
  return transaction(async (tx) => {
    const row = await tx.one<ParticipantRow>(
      `UPDATE participants p SET
         delivered_seq = LEAST(c.last_seq, GREATEST(p.delivered_seq, $3)),
         read_seq = LEAST(c.last_seq, GREATEST(p.read_seq, $4))
       FROM conversations c
       WHERE c.id = p.conversation_id AND p.conversation_id = $1 AND p.user_id = $2
         AND (p.delivered_seq < LEAST(c.last_seq, $3) OR p.read_seq < LEAST(c.last_seq, $4))
       RETURNING p.*`,
      [conversationId, userId, delivered, read],
    );
    if (!row) return null;
    const receipt: Receipt = { conversation_id: conversationId, user_id: userId, delivered_seq: row.delivered_seq, read_seq: row.read_seq };
    const members = await memberIds(conversationId, tx);
    await appendEvents(tx, members, "receipt", receipt);
    return { ...receipt, members };
  });
}

export const TYPING_HOLD_SECONDS = 8;

export async function setTyping(conversationId: string, userId: string, typing: boolean): Promise<string[]> {
  const members = await memberIds(conversationId);
  await db.query(
    `UPDATE participants SET typing_until = ${typing ? `now() + interval '${TYPING_HOLD_SECONDS} seconds'` : "NULL"}
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  const others = members.filter((id) => id !== userId);
  await signalUsers(others, { type: "typing", conversation_id: conversationId, user_id: userId, typing, hold_seconds: TYPING_HOLD_SECONDS });
  return others;
}

export async function setMuted(conversationId: string, userId: string, muted: boolean): Promise<boolean> {
  const row = await db.one("UPDATE participants SET muted = $3 WHERE conversation_id = $1 AND user_id = $2 RETURNING user_id", [conversationId, userId, muted]);
  return row !== null;
}

export interface Reacted {
  conversation_id: string;
  message_id: string;
  reactions: ReactionJson[];
  members: string[];
}

export async function setReaction(input: { conversationId: string; messageId: string; userId: string; emoji: string | null; part: "message" | "media" }): Promise<Reacted | null> {
  return transaction(async (tx) => {
    const message = await tx.one<MessageRow>("SELECT * FROM messages WHERE id = $1 AND conversation_id = $2", [input.messageId, input.conversationId]);
    if (!message) return null;
    if (input.emoji) {
      await tx.query(
        `INSERT INTO reactions (message_id, user_id, part, emoji) VALUES ($1, $2, $3, $4)
         ON CONFLICT (message_id, user_id, part) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`,
        [message.id, input.userId, input.part, input.emoji],
      );
    } else {
      await tx.query("DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND part = $3", [message.id, input.userId, input.part]);
    }
    const reactions = await tx.query<ReactionJson>(
      "SELECT user_id, emoji, part FROM reactions WHERE message_id = $1 ORDER BY created_at",
      [message.id],
    );
    const members = await memberIds(input.conversationId, tx);
    const payload = { conversation_id: input.conversationId, message_id: message.id, reactions };
    await appendEvents(tx, members, "reaction", payload);
    return { ...payload, members };
  });
}

export async function messagesIn(
  conversationId: string,
  range: { afterSeq?: number; beforeSeq?: number; limit?: number } = {},
): Promise<{ messages: MessageJson[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(range.limit ?? 50, 1), 200);
  const forward = range.afterSeq !== undefined && range.beforeSeq === undefined;
  const rows = await db.query<MessageRow & { reactions: ReactionJson[] | null }>(
    `SELECT m.*, (
       SELECT jsonb_agg(jsonb_build_object('user_id', r.user_id, 'emoji', r.emoji, 'part', r.part) ORDER BY r.created_at)
       FROM reactions r WHERE r.message_id = m.id
     ) AS reactions
     FROM messages m
     WHERE m.conversation_id = $1 AND m.seq > $2 AND m.seq < $3
     ORDER BY m.seq ${forward ? "ASC" : "DESC"} LIMIT $4`,
    [conversationId, range.afterSeq ?? 0, range.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  if (!forward) page.reverse();
  return { messages: page.map((row) => messageJson(row, row.reactions ?? [])), hasMore };
}

export async function unreadTotal(userId: string): Promise<number> {
  const row = await db.one<{ count: number }>(
    `SELECT count(*)::int AS count FROM participants p JOIN messages m ON m.conversation_id = p.conversation_id
     WHERE p.user_id = $1 AND m.seq > p.read_seq AND m.sender_id IS DISTINCT FROM $1`,
    [userId],
  );
  return row?.count ?? 0;
}

export async function previewOf(message: MessageJson): Promise<string> {
  if (message.text) return message.text;
  const images = message.media.filter((item) => item.kind !== "file").length;
  const files = message.media.length - images;
  if (images > 0 && files === 0) return images > 1 ? `${images} Photos` : "Photo";
  if (files > 0 && images === 0) return files > 1 ? `${files} Files` : (message.media[0]?.name ?? "File");
  return "Attachment";
}
