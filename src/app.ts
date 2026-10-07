import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./lib/http.js";
import { admin } from "./routes/admin.js";
import { conversations } from "./routes/conversations.js";
import { live } from "./routes/live.js";
import { uploads } from "./routes/uploads.js";
import { users } from "./routes/users.js";

function guarded(app: Hono<Env>): Hono<Env> {
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    console.error(`${c.req.method} ${c.req.path} failed:`, error);
    return c.json({ error: "Something went wrong on the server. Try again.", code: "server_error" }, 500);
  });
  app.notFound((c) => c.json({ error: "There’s nothing at that path.", code: "not_found" }, 404));
  return app;
}

export const mainApp = guarded(new Hono<Env>());
mainApp.get("/v1", (c) => c.json({ name: "swift-chat-server", version: "0.1.0", docs: "https://unionst.com/swiftchat/server" }));
mainApp.route("/v1", users);
mainApp.route("/v1", conversations);
mainApp.route("/v1", uploads);
mainApp.route("/admin", admin);

export const liveApp = guarded(new Hono<Env>());
liveApp.route("/", live);
