import { liveApp } from "../src/app.js";

export const GET = (request: Request) => liveApp.fetch(request);
