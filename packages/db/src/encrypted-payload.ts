export interface EncryptedPayloadParts {
  version: "v1";
  keyId: string;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

function decodeBase64Url(label: string, encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new TypeError(`Encrypted payload ${label} is not canonical base64url`);
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== encoded) {
    throw new TypeError(`Encrypted payload ${label} is empty or non-canonical`);
  }
  return decoded;
}

/** Parse the API FieldCipher wire form `v1.keyId.nonce.tag.ciphertext`. */
export function splitEncryptedPayload(payload: string): EncryptedPayloadParts {
  const parts = payload.split(".");
  if (parts.length !== 5) {
    throw new TypeError("Encrypted payload must contain five dot-separated parts");
  }
  const [version, keyId, nonce, authTag, ciphertext] = parts;
  if (version !== "v1") {
    throw new TypeError(`Unsupported encrypted payload version: ${version ?? "missing"}`);
  }
  if (keyId === undefined || !/^[A-Za-z0-9_-]+$/.test(keyId)) {
    throw new TypeError("Encrypted payload key ID is missing or invalid");
  }
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) {
    throw new TypeError("Encrypted payload is incomplete");
  }

  const nonceBuffer = decodeBase64Url("nonce", nonce);
  const authTagBuffer = decodeBase64Url("authentication tag", authTag);
  if (nonceBuffer.length !== 12) {
    throw new TypeError("AES-256-GCM nonce must be 12 bytes");
  }
  if (authTagBuffer.length !== 16) {
    throw new TypeError("AES-256-GCM authentication tag must be 16 bytes");
  }

  return {
    version,
    keyId,
    nonce: nonceBuffer,
    authTag: authTagBuffer,
    ciphertext: decodeBase64Url("ciphertext", ciphertext),
  };
}

/** Reassemble encrypted database fields into the API FieldCipher wire form. */
export function joinEncryptedPayload(parts: EncryptedPayloadParts): string {
  if (!/^[A-Za-z0-9_-]+$/.test(parts.keyId)) {
    throw new TypeError("Encrypted payload key ID is missing or invalid");
  }
  if (parts.nonce.length !== 12 || parts.authTag.length !== 16 || parts.ciphertext.length === 0) {
    throw new TypeError("Encrypted payload parts have invalid lengths");
  }
  return [
    parts.version,
    parts.keyId,
    parts.nonce.toString("base64url"),
    parts.authTag.toString("base64url"),
    parts.ciphertext.toString("base64url"),
  ].join(".");
}
