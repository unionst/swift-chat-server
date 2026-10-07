import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { liveApp, mainApp } from "../src/app.js";

const root = new Hono();
root.all("/v1/stream", (c) => liveApp.fetch(c.req.raw));
root.all("*", (c) => mainApp.fetch(c.req.raw));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: root.fetch, port });
console.log(`swift-chat-server on http://localhost:${port}`);
