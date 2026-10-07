import { mainApp } from "../src/app.js";

const handler = (request: Request) => mainApp.fetch(request);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
