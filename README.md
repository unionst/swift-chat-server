<div align="center">

# Swift Chat Server

The backend for [Swift Chat](https://github.com/unionst/swift-chat), on your own Vercel and Postgres.

[Deploy](#deploy-in-five-minutes) · [Swift client](#the-swift-client) · [API reference](public/llms.txt) · by [Union St](https://unionst.com)

</div>

Swift Chat draws the conversation. This is everything behind it: people, direct and group conversations, messages that arrive in order and never get lost, delivered and read receipts, typing dots, tapbacks, photo and file attachments, and push notifications. It runs as one Vercel project with one Postgres database and one Blob store, all in your account. There is no per-user bill, no vendor in the middle of your users’ messages, and nothing to migrate off later, because the data is already yours.

```swift
import SwiftChat
import SwiftChatClient

struct ThreadScreen: View {
    let client: ChatClient
    let conversationID: String

    var body: some View {
        ConversationView(client: client, conversationID: conversationID)
    }
}
```

That view is a live thread: bubbles, tails, typing dots, “Delivered” fading into “Read”, photos, tapbacks, older pages on scroll, optimistic sends that retry, all wired to your server.

## What you get

- **People.** Users are created from your backend with your own ids, or anonymously for prototypes.
- **Conversations.** Direct (found again by the pair, so there is only ever one) and named groups with add, leave and rename.
- **Messages in order.** Each conversation owns a sequence number bumped inside the write transaction, so a reader asking for “after N” cannot miss a row that committed late.
- **Live.** One Server-Sent Events stream per user, woken by Postgres `LISTEN/NOTIFY`, resumed from a cursor. A dropped connection costs latency, not messages.
- **Receipts.** Delivered when the message reaches a device (its stream or its push), read when the person opens the thread.
- **Typing**, **tapbacks** (per message part, so a photo with a caption has two), **attachments** on Vercel Blob, **push** over APNs with unread badges.
- **A Swift client** that does the hard part on the phone: optimistic bubbles that become the stored row without flicker, idempotent resends, a cached inbox, reconnect with backoff.
- **An admin API** so your backend can create users, mint tokens, open conversations and speak into them.

## Deploy in five minutes

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Funionst%2Fswift-chat-server&project-name=swift-chat-server&repository-name=swift-chat-server&env=SWIFT_CHAT_SECRET&envDescription=A%20long%20random%20string.%20It%20signs%20user%20tokens%20and%20guards%20the%20admin%20API.&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%7D%2C%7B%22type%22%3A%22blob%22%7D%5D)

The button clones this repo into your Vercel account, attaches a Neon Postgres database and a Blob store, and asks for one value, `SWIFT_CHAT_SECRET`. The schema is applied on every build, so the deployment is ready when the build finishes.

Or from a terminal:

```sh
git clone https://github.com/unionst/swift-chat-server
cd swift-chat-server
vercel link
vercel integration add neon          # or any Postgres: set DATABASE_URL and DATABASE_URL_UNPOOLED
vercel blob store add swift-chat-media
openssl rand -base64 32 | vercel env add SWIFT_CHAT_SECRET production
vercel --prod
```

Environment variables:

| Name | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Pooled Postgres connection string. Neon sets it for you. |
| `DATABASE_URL_UNPOOLED` | recommended | Direct connection for `LISTEN`. Falls back to `DATABASE_URL`. |
| `SWIFT_CHAT_SECRET` | yes | Signs user tokens and guards `/admin`. |
| `BLOB_READ_WRITE_TOKEN` | for attachments | Set by the Blob store. Without it, text still works and uploads answer 503. |
| `ALLOW_ANONYMOUS_USERS` | no | `1` lets the app sign in with just a name. For prototypes. |
| `USER_DIRECTORY` | no | `0` turns off `GET /v1/users` search. |
| `ALLOW_EXTERNAL_MEDIA` | no | `1` lets messages carry `https` media from any host, not only your Blob store. |
| `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_KEY`, `APNS_BUNDLE_ID` | for push | Your Apple team, a `.p8` key id, its contents, and the app’s bundle id. |

## Signing people in

Your backend already knows who the user is. It creates them here and hands the app a token:

```sh
curl -X POST https://your-deployment.vercel.app/admin/users \
  -H "Authorization: Bearer $SWIFT_CHAT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"external_id": "user_42", "name": "Alice", "avatar_url": "https://…/alice.jpg"}'
# → {"user": {"id": "usr_…", "external_id": "user_42", …}, "token": "…"}
```

Calling it again with the same `external_id` returns the same user, so your sign-in handler can call it every time. Tokens last a year by default (`token_lifetime_seconds` shortens that). The app then calls `client.signIn(token:)`.

No backend yet? Set `ALLOW_ANONYMOUS_USERS=1` and call `client.signInAnonymously(name:)`. Swap it for real tokens before launch.

## The Swift client

Add the package in Xcode (File › Add Package Dependencies) or in `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/unionst/swift-chat.git", from: "1.0.7"),
    .package(url: "https://github.com/unionst/swift-chat-server.git", from: "0.1.0")
],
targets: [
    .target(name: "MyApp", dependencies: [
        .product(name: "SwiftChat", package: "swift-chat"),
        .product(name: "SwiftChatClient", package: "swift-chat-server")
    ])
]
```

One `ChatClient` per app, pointed at your deployment:

```swift
@main
struct MyApp: App {
    @State private var client = ChatClient(baseURL: URL(string: "https://your-deployment.vercel.app")!)

    var body: some Scene {
        WindowGroup {
            RootView(client: client)
        }
    }
}
```

Sign in, and the client opens its stream and keeps `conversations` and each thread current:

```swift
try await client.signIn(token: tokenFromYourBackend)

List(client.conversations) { conversation in
    NavigationLink(value: conversation.id) {
        ConversationRow(client: client, conversation: conversation)
    }
}
.navigationDestination(for: String.self) { id in
    ConversationView(client: client, conversationID: id)
}
```

`ConversationView` is a `Chat` with everything attached. Every Swift Chat modifier still works on it (`.chatInputPlaceholder`, `.chatBubbleStyle`, `.chatHeader`, …), because they travel through the environment. When you want your own transcript, build it from the same pieces:

```swift
Chat(client.messages(in: id), typingUsers: client.typingRoles(in: id)) { message in
    client.transcriptRow(for: message, lastOutgoingID: client.lastOutgoingID(in: id), in: client.conversation(id))
}
.chatMessageContextMenu { (messageID: String) in client.contextMenuItems(for: messageID, in: id) }
.chatLoadsOlderMessages { await client.loadOlder(in: id) }
.onChatSend { text, media in await client.send(text: text, media: media, in: id) }
.onChatTypingChanged { typing in Task { @MainActor in client.setTyping(typing, in: id) } }
.task { await client.open(id) }
.onDisappear { client.close(id) }
```

Other things the client does:

```swift
let people = try await client.searchUsers("bo")
let conversation = try await client.startConversation(with: [people[0].id])
let group = try await client.startConversation(with: ids, name: "The Crew")
try await client.addMembers([id], to: group.id)
try await client.rename(group.id, to: "The Crew 2")
try await client.setMuted(true, in: group.id)
await client.leave(group.id)
client.toggleReaction("❤️", on: messageID, in: conversation.id)
client.registerDevice(token: deviceToken)        // from didRegisterForRemoteNotificationsWithDeviceToken
client.totalUnread                               // the client also keeps the app badge in step
client.signOut()
```

## Your backend can talk too

Everything under `/admin` takes the server secret. Use it for support tooling, bots, system messages, or to open a conversation for two people before either has opened the app:

```sh
# a conversation between two of your users
curl -X POST …/admin/conversations -H "Authorization: Bearer $SECRET" \
  -d '{"member_external_ids": ["user_42", "user_7"]}'

# a message from your backend, as a person or as the system (no sender)
curl -X POST …/admin/conversations/cnv_…/messages -H "Authorization: Bearer $SECRET" \
  -d '{"sender_external_id": "user_7", "text": "Your order shipped."}'
```

The full reference, every route and event with its fields, is [`public/llms.txt`](public/llms.txt). It is served from your deployment at `/llms.txt`, so a coding agent pointed at your server can read it too.

## How it stays correct

- `conversations.last_seq` orders a thread; `users.event_seq` orders each person’s event log. Both are bumped under the row lock in the same transaction as the write.
- A message is written once and fanned out as an event into every participant’s log in that transaction. The phone streams its own log from a cursor and can replay from zero.
- A message row’s identity on the phone is `client_id ?? id`, so the optimistic bubble and the stored row are the same row. Resends carry the same `client_id` and are idempotent on the server.
- Typing dots ride inside the `NOTIFY` payload and are never stored. Everything else is re-read from the tables when a signal arrives, with a 15 second heartbeat as the fallback poll.
- Receipts are per participant. For a group, your bubble says “Delivered” when everyone has it and “Read” when everyone has read it.

## Limits worth knowing

- Attachments go through the function, so they are capped at 4 MB each. The client resizes photos to 1600 px JPEG before upload, which lands well under that. Videos over the cap are refused.
- A conversation’s event fan-out is one row per participant per message. Groups of a few hundred are fine; broadcast channels of thousands are not what this is for.
- Streams end themselves after 270 seconds with a `bye` and the client reconnects from its cursor. On Vercel this needs Fluid Compute (the default) and `maxDuration: 300`, which `vercel.json` sets.

## Develop

```sh
npm install
cp .env.example .env.local        # fill in DATABASE_URL, DATABASE_URL_UNPOOLED, SWIFT_CHAT_SECRET
npm run migrate
npm run dev                       # http://localhost:8787
npm run e2e                       # 45 checks: users, streams, receipts, typing, groups, paging, admin
SWIFT_CHAT_BASE=https://your-deployment.vercel.app npm run e2e
```

`Examples/Demo` is a small app (xcodegen) that signs in, lists conversations and opens threads against a deployment.

## License

MIT for the server and the Swift client in this repository. Swift Chat itself has [its own license](https://github.com/unionst/swift-chat).
