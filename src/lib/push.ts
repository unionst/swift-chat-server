import { pushConfigured, pushToDevice, type PushEnvironment } from "./apns.js";
import { markProgress, previewOf, unreadTotal, type Posted } from "./chat.js";
import { db } from "./db.js";
import { signalUsers } from "./signal.js";

export async function pushMessage(posted: Posted): Promise<void> {
  if (!posted.fresh || !pushConfigured()) return;
  const recipients = await db.query<{ user_id: string; muted: boolean }>(
    "SELECT user_id, muted FROM participants WHERE conversation_id = $1 AND user_id <> COALESCE($2, '')",
    [posted.conversation.id, posted.message.sender_id],
  );
  const audible = recipients.filter((recipient) => !recipient.muted).map((recipient) => recipient.user_id);
  if (audible.length === 0) return;

  const devices = await db.query<{ token: string; user_id: string; environment: PushEnvironment }>(
    "SELECT token, user_id, environment FROM devices WHERE user_id = ANY($1::text[])",
    [audible],
  );
  if (devices.length === 0) return;

  const body = await previewOf(posted.message);
  const senderName = posted.sender?.name ?? "Someone";
  const title = posted.conversation.name ?? senderName;
  const subtitle = posted.conversation.name ? senderName : undefined;
  const badges = new Map<string, number>();
  for (const userId of new Set(devices.map((device) => device.user_id))) badges.set(userId, await unreadTotal(userId));

  const reached = new Set<string>();
  await Promise.all(
    devices.map(async (device) => {
      const outcome = await pushToDevice({
        token: device.token,
        environment: device.environment,
        aps: {
          alert: { title, ...(subtitle ? { subtitle } : {}), body },
          sound: "default",
          badge: badges.get(device.user_id) ?? 1,
          "thread-id": posted.conversation.id,
          "mutable-content": 1,
        },
        data: {
          conversation_id: posted.conversation.id,
          message_id: posted.message.id,
          sender_id: posted.message.sender_id,
          avatar_url: posted.sender?.avatar_url ?? null,
        },
      });
      if (outcome.dead) {
        await db.query("DELETE FROM devices WHERE token = $1", [device.token]);
      } else if (outcome.environment && outcome.environment !== device.environment) {
        await db.query("UPDATE devices SET environment = $2 WHERE token = $1", [device.token, outcome.environment]);
      }
      if (outcome.environment) reached.add(device.user_id);
      else console.error(`push failed for ${device.user_id}: ${outcome.reason}`);
    }),
  );

  for (const userId of reached) {
    const receipt = await markProgress(posted.conversation.id, userId, { delivered: posted.message.seq });
    if (receipt) await signalUsers(receipt.members);
  }
}
