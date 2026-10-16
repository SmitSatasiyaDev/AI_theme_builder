import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "crypto";
import { requireEnv } from "./env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (!cachedKey) {
    cachedKey = scryptSync(requireEnv("ENCRYPTION_KEY"), "ai-schema-saas", 32);
  }
  return cachedKey;
}

// Encrypts a secret (e.g. a Shopify access token) for storage at rest.
// Returns "iv:authTag:ciphertext", all hex-encoded.
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(payload: string): string {
  const key = getKey();
  const [ivHex, authTagHex, ciphertextHex] = payload.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted payload");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
