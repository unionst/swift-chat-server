import { waitUntil } from "@vercel/functions";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { markProgress } from "../lib/chat.js";
import { db } from "../lib/db.js";
import { userFrom, type Env } from "../lib/http.js";
import { listening, signalUsers, userKey, waiterFor } from "../lib/signal.js";

const STREAM_LIFETIME_MS = 270_000;
const STREAM_HEARTBEAT_MS = 15_000;
const STREAM_PAGE = 200;
const EVENT_RETENTION = "14 days";

interface EventRow {
  seq: number;
  type: string;
  payload: Record<string, any>;
}

async function deliveredOnArrival(userId: string, events: EventRow[]): Promise<void> {
  const newest = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "message") continue;
    const message = event.payload.message;
    if (!message || message.sender_id === userId) continue;
    newest.set(event.payload.conversation_id, Math.max(newest.get(event.payload.conversation_id) ?? 0, message.seq));
  }
  for (const [conversationId, seq] of newest) {
    const receipt = await markProgress(conversationId, userId, { delivered: seq });
    if (receipt) await signalUsers(receipt.members.filter((id) => id !== userId));
  }
}

export const live = new Hono<Env>();

live.get("/v1/stream", async (c) => {
  const user = await userFrom(c);
  const requested = Number(c.req.query("after") ?? c.req.header("last-event-id"));
  let cursor = Number.isFinite(requested) && requested >= 0 ? requested : user.event_seq;
  if (Math.random() < 0.02) waitUntil(db.query(`DELETE FROM user_events WHERE created_at < now() - interval '${EVENT_RETENTION}'`));

  return streamSSE(c, async (stream) => {
    const waiter = waiterFor(userKey(user.id));
    let open = true;
    stream.onAbort(() => {
      open = false;
      waiter.close();
    });
    const endsAt = Date.now() + STREAM_LIFETIME_MS;
    try {
      await listening();
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ cursor, user_id: user.id }) });
      let check = true;
      while (open && Date.now() < endsAt) {
        if (check) {
          for (;;) {
            const events = await db.query<EventRow>(
              "SELECT seq, type, payload FROM user_events WHERE user_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
              [user.id, cursor, STREAM_PAGE],
            );
            for (const event of events) {
              await stream.writeSSE({ id: String(event.seq), event: event.type, data: JSON.stringify(event.payload) });
              cursor = event.seq;
            }
            if (events.length > 0) waitUntil(deliveredOnArrival(user.id, events).catch(() => {}));
            if (events.length < STREAM_PAGE) break;
          }
        }
        const woke = await waiter.next(STREAM_HEARTBEAT_MS);
        if (!open) break;
        for (const passing of woke.passing) {
          const { type, ...data } = passing;
          await stream.writeSSE({ event: type, data: JSON.stringify(data) });
        }
        const idle = !woke.durable && woke.passing.length === 0;
        if (idle) await stream.writeSSE({ event: "ping", data: "{}" });
        check = woke.durable || idle;
      }
      if (open) await stream.writeSSE({ event: "bye", data: JSON.stringify({ cursor }) });
    } finally {
      waiter.close();
    }
  });
});
