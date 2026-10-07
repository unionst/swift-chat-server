import { readFileSync } from "node:fs";

const BASE = process.env.SWIFT_CHAT_BASE ?? "http://localhost:8787";
const SECRET = process.env.SWIFT_CHAT_SECRET ?? readSecret();

function readSecret() {
  try {
    const file = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const line = file.split("\n").find((entry) => entry.startsWith("SWIFT_CHAT_SECRET="));
    return line ? line.slice("SWIFT_CHAT_SECRET=".length).trim() : "";
  } catch {
    return "";
  }
}

let failures = 0;
function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures += 1;
}

async function call(method, path, { token, body, raw, headers } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  return { status: response.status, json };
}

function listen(token, after, seen) {
  const controller = new AbortController();
  (async () => {
    try {
      const response = await fetch(`${BASE}/v1/stream?after=${after}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = { event: "message", data: "", at: Date.now() };
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event.event = line.slice(6).trim();
            if (line.startsWith("data:")) event.data += line.slice(5).trim();
            if (line.startsWith("id:")) event.id = Number(line.slice(3).trim());
          }
          try {
            event.json = JSON.parse(event.data);
          } catch {}
          seen.push(event);
        }
      }
    } catch {}
  })();
  return () => controller.abort();
}

async function waitFor(seen, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = seen.find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

const run = Date.now().toString(36);

const root = await call("GET", "/v1");
check("GET /v1 answers", root.status === 200 && root.json.name === "swift-chat-server");

const noAuth = await call("GET", "/v1/conversations");
check("user routes refuse a missing token", noAuth.status === 401);

const badAdmin = await call("POST", "/admin/users", { token: "nope", body: { external_id: "x" } });
check("admin routes refuse a wrong secret", badAdmin.status === 401);

const alice = await call("POST", "/admin/users", { token: SECRET, body: { external_id: `alice-${run}`, name: "Alice" } });
check("admin creates Alice with a token", alice.status === 200 && alice.json.token && alice.json.user.external_id === `alice-${run}`);
const again = await call("POST", "/admin/users", { token: SECRET, body: { external_id: `alice-${run}` } });
check("upsert by external_id keeps the same user and name", again.json.user.id === alice.json.user.id && again.json.user.name === "Alice");

const bob = await call("POST", "/admin/users", { token: SECRET, body: { external_id: `bob-${run}`, name: "Bob", avatar_url: "https://example.com/bob.jpg" } });
const carol = await call("POST", "/admin/users", { token: SECRET, body: { external_id: `carol-${run}`, name: "Carol" } });
const A = alice.json.token, B = bob.json.token, C = carol.json.token;
const aliceId = alice.json.user.id, bobId = bob.json.user.id, carolId = carol.json.user.id;

const me = await call("GET", "/v1/me", { token: A });
check("GET /v1/me returns the user and event_seq", me.status === 200 && me.json.user.id === aliceId && typeof me.json.event_seq === "number");

const anon = await call("POST", "/v1/users/anonymous", { body: { name: "Guest" } });
check("anonymous sign-in works when enabled", anon.status === 200 || anon.status === 403, `status ${anon.status}`);

const directory = await call("GET", `/v1/users?q=Bob`, { token: A });
check("user directory finds Bob by name", directory.status === 200 && directory.json.users.some((user) => user.id === bobId));

const listA0 = await call("GET", "/v1/conversations", { token: A });
const listB0 = await call("GET", "/v1/conversations", { token: B });
const seenA = [], seenB = [];
const stopA = listen(A, listA0.json.event_seq, seenA);
const stopB = listen(B, listB0.json.event_seq, seenB);
check("Alice stream says hello", Boolean(await waitFor(seenA, (e) => e.event === "hello")));

const dm = await call("POST", "/v1/conversations", { token: A, body: { member_external_ids: [`bob-${run}`] } });
check("Alice opens a direct conversation with Bob", dm.status === 200 && dm.json.created === true && dm.json.conversation.direct === true && dm.json.conversation.participants.length === 2);
const dmId = dm.json.conversation.id;
const dmAgain = await call("POST", "/v1/conversations", { token: B, body: { member_ids: [aliceId] } });
check("the same pair finds the same direct conversation", dmAgain.json.created === false && dmAgain.json.conversation.id === dmId);
check("Bob's stream learns about the conversation", Boolean(await waitFor(seenB, (e) => e.event === "conversation_updated" && e.json.conversation_id === dmId)));

const clientId = `c-${run}-1`;
const sent = await call("POST", `/v1/conversations/${dmId}/messages`, { token: A, body: { text: "hey bob", client_id: clientId } });
check("Alice sends a message", sent.status === 200 && sent.json.message.seq === 1 && sent.json.message.sender_id === aliceId && sent.json.message.client_id === clientId);
const resent = await call("POST", `/v1/conversations/${dmId}/messages`, { token: A, body: { text: "hey bob", client_id: clientId } });
check("a resend with the same client_id is idempotent", resent.json.message.id === sent.json.message.id);
const arrived = await waitFor(seenB, (e) => e.event === "message" && e.json.message?.id === sent.json.message.id);
check("Bob's stream gets the message", Boolean(arrived), arrived ? `${arrived.at - Date.now() > 0 ? 0 : ""}` : "");
const deliveredReceipt = await waitFor(seenA, (e) => e.event === "receipt" && e.json.user_id === bobId && e.json.delivered_seq >= 1);
check("Alice sees Delivered once Bob's stream received it", Boolean(deliveredReceipt));

const read = await call("POST", `/v1/conversations/${dmId}/read`, { token: B, body: { seq: 1 } });
check("Bob marks read", read.status === 200);
const readReceipt = await waitFor(seenA, (e) => e.event === "receipt" && e.json.user_id === bobId && e.json.read_seq >= 1);
check("Alice sees Read", Boolean(readReceipt));

const typing = await call("POST", `/v1/conversations/${dmId}/typing`, { token: B, body: { typing: true } });
check("Bob starts typing", typing.status === 200);
const typingEvent = await waitFor(seenA, (e) => e.event === "typing" && e.json.user_id === bobId && e.json.typing === true);
check("Alice sees typing dots", Boolean(typingEvent));
const typingOff = await call("POST", `/v1/conversations/${dmId}/typing`, { token: B, body: { typing: false } });
check("Alice sees typing stop", typingOff.status === 200 && Boolean(await waitFor(seenA, (e) => e.event === "typing" && e.json.user_id === bobId && e.json.typing === false)));

const reaction = await call("PUT", `/v1/conversations/${dmId}/messages/${sent.json.message.id}/reaction`, { token: B, body: { emoji: "❤️" } });
check("Bob reacts", reaction.status === 200 && reaction.json.reactions.length === 1 && reaction.json.reactions[0].user_id === bobId);
check("Alice sees the reaction", Boolean(await waitFor(seenA, (e) => e.event === "reaction" && e.json.message_id === sent.json.message.id && e.json.reactions.length === 1)));
const unreact = await call("PUT", `/v1/conversations/${dmId}/messages/${sent.json.message.id}/reaction`, { token: B, body: { emoji: null } });
check("Bob removes the reaction", unreact.json.reactions.length === 0);

const stranger = await call("GET", `/v1/conversations/${dmId}/messages`, { token: C });
check("Carol cannot read a conversation she isn't in", stranger.status === 404);

for (let i = 2; i <= 6; i += 1) await call("POST", `/v1/conversations/${dmId}/messages`, { token: B, body: { text: `reply ${i}` } });
const page = await call("GET", `/v1/conversations/${dmId}/messages?limit=3`, { token: A });
check("newest page has 3 messages and has_more", page.json.messages.length === 3 && page.json.has_more === true && page.json.messages[2].seq === 6);
const older = await call("GET", `/v1/conversations/${dmId}/messages?before_seq=${page.json.messages[0].seq}&limit=10`, { token: A });
check("older page reaches seq 1 and has_more false", older.json.messages[0].seq === 1 && older.json.has_more === false);
const forward = await call("GET", `/v1/conversations/${dmId}/messages?after_seq=4`, { token: A });
check("after_seq pages forward", forward.json.messages.map((m) => m.seq).join() === "5,6");
check("Alice has 5 unread", page.json.conversation.unread === 5, `unread ${page.json.conversation.unread}`);

const group = await call("POST", "/v1/conversations", { token: A, body: { member_ids: [bobId, carolId], name: "The Crew" } });
check("Alice makes a group", group.status === 200 && group.json.conversation.direct === false && group.json.conversation.name === "The Crew" && group.json.conversation.participants.length === 3);
const groupId = group.json.conversation.id;
const groupMsg = await call("POST", `/v1/conversations/${groupId}/messages`, { token: C, body: { text: "hi all" } });
check("Carol posts in the group", groupMsg.status === 200);
check("Bob's stream gets the group message", Boolean(await waitFor(seenB, (e) => e.event === "message" && e.json.conversation_id === groupId)));
const rename = await call("PATCH", `/v1/conversations/${groupId}`, { token: B, body: { name: "The Crew 2", muted: true } });
check("Bob renames and mutes", rename.json.conversation.name === "The Crew 2" && rename.json.conversation.me.muted === true);
const leave = await call("DELETE", `/v1/conversations/${groupId}/members/me`, { token: C });
check("Carol leaves", leave.status === 200);
const afterLeave = await call("GET", `/v1/conversations/${groupId}`, { token: A });
check("the group has two people left", afterLeave.json.conversation.participants.length === 2);
const readd = await call("POST", `/v1/conversations/${groupId}/members`, { token: A, body: { member_ids: [carolId] } });
check("Carol is added back with read_seq at the current end", readd.json.conversation.participants.length === 3 && readd.json.conversation.participants.find((p) => p.user.id === carolId).read_seq === afterLeave.json.conversation.last_seq);

const adminMsg = await call("POST", `/admin/conversations/${dmId}/messages`, { token: SECRET, body: { text: "system note" } });
check("admin posts a message with no sender", adminMsg.status === 200 && adminMsg.json.message.sender_id === null);
const asBob = await call("POST", `/admin/conversations/${dmId}/messages`, { token: SECRET, body: { sender_external_id: `bob-${run}`, text: "from the backend as bob" } });
check("admin posts as Bob", asBob.json.message.sender_id === bobId);
const adminRead = await call("GET", `/admin/conversations/${dmId}/messages?limit=2`, { token: SECRET });
check("admin reads messages", adminRead.json.messages.length === 2);

const upload = await call("POST", "/v1/uploads", { token: A, raw: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), headers: { "Content-Type": "image/jpeg" } });
check("upload answers (needs Blob to succeed)", upload.status === 200 || upload.status === 503, `status ${upload.status} ${upload.json.code ?? ""}`);
if (upload.status === 200) {
  const withMedia = await call("POST", `/v1/conversations/${dmId}/messages`, { token: A, body: { media: [{ url: upload.json.url, width: 10, height: 10 }] } });
  check("a photo message stores media", withMedia.status === 200 && withMedia.json.media?.length !== 0);
}
const foreign = await call("POST", `/v1/conversations/${dmId}/messages`, { token: A, body: { media: [{ url: "https://evil.example/x.jpg" }] } });
check("media from other hosts is dropped", foreign.status === 400);

const device = await call("POST", "/v1/devices", { token: A, body: { token: "ab".repeat(32), environment: "sandbox" } });
check("device registers", device.status === 200);
const unregister = await call("DELETE", `/v1/devices/${"ab".repeat(32)}`, { token: A });
check("device unregisters", unregister.status === 200);

const lastEvent = seenA.filter((e) => e.id).at(-1)?.id ?? 0;
const seenA2 = [];
const stopA2 = listen(A, 0, seenA2);
const replay = await waitFor(seenA2, (e) => e.id === lastEvent, 8000);
check("a stream from cursor 0 replays Alice's whole event log", Boolean(replay));
stopA2();

stopA();
stopB();
const del = await call("DELETE", `/admin/users/${carolId}`, { token: SECRET });
check("admin deletes Carol", del.status === 200);
await call("DELETE", `/admin/users/${aliceId}`, { token: SECRET });
await call("DELETE", `/admin/users/${bobId}`, { token: SECRET });
if (anon.status === 200) await call("DELETE", `/admin/users/${anon.json.user.id}`, { token: SECRET });

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
