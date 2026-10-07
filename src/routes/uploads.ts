import { put } from "@vercel/blob";
import { Hono } from "hono";
import { fail, userFrom, type Env } from "../lib/http.js";
import { newId } from "../lib/secrets.js";

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "text/plain": "txt",
  "application/zip": "zip",
};

export async function storeUpload(body: ArrayBuffer, contentType: string, folder: string, filename: string | null): Promise<string> {
  const type = contentType.split(";")[0].trim().toLowerCase() || "application/octet-stream";
  const extension = EXTENSIONS[type] ?? (filename?.includes(".") ? filename.split(".").pop()!.toLowerCase().slice(0, 8) : "bin");
  if (body.byteLength === 0) fail(400, "empty_upload", "The upload was empty.");
  if (body.byteLength > MAX_UPLOAD_BYTES) fail(413, "too_large", "Attachments can be at most 4 MB. Resize photos before uploading.");
  if (!process.env.BLOB_READ_WRITE_TOKEN) fail(503, "blob_not_configured", "Add a Vercel Blob store to the project to send attachments.");
  const stored = await put(`${folder}/${newId("att", 20)}.${extension}`, Buffer.from(body), { access: "public", contentType: type, addRandomSuffix: false });
  return stored.url;
}

export const uploads = new Hono<Env>();

uploads.post("/uploads", async (c) => {
  const user = await userFrom(c);
  const filename = c.req.header("x-filename") ?? null;
  const url = await storeUpload(await c.req.arrayBuffer(), c.req.header("content-type") ?? "", `u/${user.id}`, filename);
  return c.json({ url });
});
