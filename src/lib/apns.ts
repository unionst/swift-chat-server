import crypto from "node:crypto";
import http2 from "node:http2";

export type PushEnvironment = "production" | "sandbox";

const HOSTS: Record<PushEnvironment, string> = {
  production: "api.push.apple.com",
  sandbox: "api.sandbox.push.apple.com",
};

const KEYS: Record<PushEnvironment, { id: () => string | undefined; pem: () => string | undefined }> = {
  production: { id: () => process.env.APNS_KEY_ID, pem: () => process.env.APNS_KEY },
  sandbox: {
    id: () => process.env.APNS_SANDBOX_KEY_ID || process.env.APNS_KEY_ID,
    pem: () => process.env.APNS_SANDBOX_KEY || process.env.APNS_KEY,
  },
};

const minted = new Map<PushEnvironment, { value: string; at: number }>();

export function pushConfigured(): boolean {
  return Boolean(process.env.APNS_TEAM_ID && process.env.APNS_KEY_ID && process.env.APNS_KEY && process.env.APNS_BUNDLE_ID);
}

function bundleId(): string {
  const id = process.env.APNS_BUNDLE_ID;
  if (!id) throw new Error("APNS_BUNDLE_ID is not set");
  return id;
}

function providerToken(environment: PushEnvironment): string {
  const keyId = KEYS[environment].id();
  const teamId = process.env.APNS_TEAM_ID;
  const key = (KEYS[environment].pem() || "").replace(/\\n/g, "\n").trim();
  if (!keyId || !teamId || !key) throw new Error(`APNs ${environment} credentials missing`);

  const cached = minted.get(environment);
  if (cached && Date.now() - cached.at < 40 * 60 * 1000) return cached.value;

  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "ES256", kid: keyId })}.${encode({ iss: teamId, iat: now })}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  const value = `${signingInput}.${signature.toString("base64url")}`;
  minted.set(environment, { value, at: Date.now() });
  return value;
}

interface PostResult {
  ok: boolean;
  status: number;
  reason: string | null;
}

function post(environment: PushEnvironment, token: string, payload: unknown, collapseId: string | null): Promise<PostResult> {
  return new Promise((resolve) => {
    let authorization: string;
    try {
      authorization = `bearer ${providerToken(environment)}`;
    } catch (error) {
      resolve({ ok: false, status: 0, reason: (error as Error).message });
      return;
    }
    const client = http2.connect(`https://${HOSTS[environment]}`);
    let status = 0;
    let text = "";
    let settled = false;
    const settle = (result: PostResult) => {
      if (settled) return;
      settled = true;
      client.close();
      resolve(result);
    };
    client.on("error", (error) => settle({ ok: false, status: 0, reason: error.message }));

    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization,
      "apns-topic": bundleId(),
      "apns-push-type": "alert",
      "apns-priority": "10",
      ...(collapseId ? { "apns-collapse-id": collapseId } : {}),
    });
    request.setTimeout(10_000, () => settle({ ok: false, status: 0, reason: "timeout" }));
    request.on("response", (headers) => {
      status = Number(headers[":status"]) || 0;
    });
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("error", (error) => settle({ ok: false, status: 0, reason: error.message }));
    request.on("end", () => {
      let reason: string | null = null;
      try {
        reason = text ? JSON.parse(text).reason : null;
      } catch {
        reason = text || null;
      }
      settle({ ok: status === 200, status, reason });
    });
    request.write(JSON.stringify(payload));
    request.end();
  });
}

export interface PushOutcome {
  environment: PushEnvironment | null;
  dead: boolean;
  reason?: string | null;
}

export async function pushToDevice(input: {
  token: string;
  environment: PushEnvironment;
  aps: Record<string, unknown>;
  data?: Record<string, unknown>;
  collapseId?: string | null;
}): Promise<PushOutcome> {
  const payload = { aps: input.aps, ...(input.data ?? {}) };
  const first: PushEnvironment = input.environment === "sandbox" ? "sandbox" : "production";
  const second: PushEnvironment = first === "sandbox" ? "production" : "sandbox";

  let result = await post(first, input.token, payload, input.collapseId ?? null);
  if (result.ok) return { environment: first, dead: false };

  if (result.reason === "BadDeviceToken" || result.reason === "BadEnvironmentKeyInToken") {
    const retry = await post(second, input.token, payload, input.collapseId ?? null);
    if (retry.ok) return { environment: second, dead: false };
    result = retry;
  }
  const dead = result.reason === "Unregistered" || result.reason === "BadDeviceToken";
  return { environment: null, dead, reason: result.reason };
}
