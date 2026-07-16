import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class FieldCipher {
  readonly #key: Buffer;
  readonly #keyId: string;

  constructor(hexKey: string, keyId = "primary") {
    if (!/^[0-9a-f]{64}$/i.test(hexKey)) {
      throw new Error("Encryption key must be exactly 32 bytes encoded as hexadecimal");
    }
    this.#key = Buffer.from(hexKey, "hex");
    this.#keyId = keyId;
  }

  encrypt(plaintext: string, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.#key, nonce);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      this.#keyId,
      nonce.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  decrypt(payload: string, context: string): string {
    const [version, keyId, nonceValue, tagValue, ciphertextValue] = payload.split(".");
    if (
      version !== VERSION ||
      keyId !== this.#keyId ||
      !nonceValue ||
      !tagValue ||
      !ciphertextValue
    ) {
      throw new Error("Unsupported or malformed encrypted value");
    }
    const decipher = createDecipheriv(ALGORITHM, this.#key, Buffer.from(nonceValue, "base64url"));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}
