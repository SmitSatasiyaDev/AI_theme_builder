import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { requireEnv } from "../env";

// Signs/verifies the OAuth `state` param so the callback can trust which org
// initiated the install without re-deriving it from user-controlled input.
function getSecret(): string {
  return requireEnv("AUTH_SECRET");
}

export function createOAuthState(orgId: string): { state: string; nonce: string } {
  const nonce = randomUUID();
  const payload = `${orgId}.${nonce}`;
  const signature = createHmac("sha256", getSecret()).update(payload).digest("hex");
  const state = Buffer.from(`${payload}.${signature}`, "utf8").toString("base64url");
  return { state, nonce };
}

export function verifyOAuthState(state: string, expectedNonce: string): { orgId: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(state, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const parts = decoded.split(".");
  if (parts.length !== 3) return null;
  const [orgId, nonce, signature] = parts;
  if (nonce !== expectedNonce) return null;

  const expectedSignature = createHmac("sha256", getSecret()).update(`${orgId}.${nonce}`).digest("hex");
  const sigBuf = Buffer.from(signature, "hex");
  const expectedBuf = Buffer.from(expectedSignature, "hex");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  return { orgId };
}
