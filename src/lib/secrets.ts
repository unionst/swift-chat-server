import crypto from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function newId(prefix: string, length = 16): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function serverSecret(): string {
  const value = process.env.SWIFT_CHAT_SECRET;
  if (!value) throw new Error("SWIFT_CHAT_SECRET is not set");
  return value;
}

function derived(purpose: string): Buffer {
  return crypto.createHmac("sha256", serverSecret()).update(purpose).digest();
}

const DEFAULT_TOKEN_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

export function issueToken(userId: string, lifetimeSeconds = DEFAULT_TOKEN_LIFETIME_SECONDS): string {
  const claims = { uid: userId, exp: Math.floor(Date.now() / 1000) + lifetimeSeconds };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", derived("user-token")).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function readToken(token: string | null | undefined): string | null {
  if (typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", derived("user-token")).update(payload).digest("base64url");
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims?.uid !== "string" || !claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims.uid;
  } catch {
    return null;
  }
}

export function isServerSecret(candidate: string | null): boolean {
  if (!candidate) return false;
  const given = Buffer.from(candidate);
  const want = Buffer.from(serverSecret());
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
