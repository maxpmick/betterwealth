import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "./errors";

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Bytes(address: string): Uint8Array | undefined {
  let normalized = address.toLowerCase();
  const zone = normalized.indexOf("%");
  if (zone >= 0) normalized = normalized.slice(0, zone);
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(separator + 1);
    if (isIP(ipv4) !== 4) return undefined;
    const octets = ipv4.split(".").map(Number);
    normalized = `${normalized.slice(0, separator)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const sides = normalized.split("::");
  if (sides.length > 2) return undefined;
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides[1] ? sides[1].split(":") : [];
  if (sides.length === 1 && left.length !== 8) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (sides.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return undefined;
  }
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

function isPrivateIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  if (allZero || loopback) return true;
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) {
    return isPrivateIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if ((bytes[0]! & 0xfe) === 0xfc) return true; // unique-local fc00::/7
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (bytes[0] === 0xff) return true; // multicast
  // Only globally routable unicast is eligible. Explicitly reject documentation and transition
  // ranges that can encode a non-public IPv4 destination.
  if ((bytes[0]! & 0xe0) !== 0x20) return true; // outside 2000::/3
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return true; // documentation 2001:db8::/32
  }
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2]! & 0xf0) === 0) {
    return true; // documentation 3fff::/20
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPrivateIpv4(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`); // 6to4
  }
  return false;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !isPrivateIpv4(address) : family === 6 ? !isPrivateIpv6(address) : false;
}

async function assertSafeUrl(url: URL, allowedHosts?: ReadonlySet<string>) {
  if (url.protocol !== "https:")
    throw new AppError("Integration URLs must use HTTPS", 400, "unsafe_url");
  if (allowedHosts && !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new AppError("This integration host is not allowed", 400, "host_not_allowed");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) {
    throw new AppError("Local integration hosts are not allowed", 400, "unsafe_url");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new AppError("Integration host resolves to a non-public address", 400, "unsafe_url");
  }
}

export async function safeFetch(
  input: string | URL,
  init: RequestInit & {
    allowedHosts?: ReadonlySet<string>;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
  } = {},
): Promise<Response> {
  let url = new URL(input);
  const {
    allowedHosts,
    timeoutMs = 20_000,
    maxBytes = 10_000_000,
    maxRedirects = 2,
    ...requestInit
  } = init;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      await assertSafeUrl(url, allowedHosts);
      const response = await fetch(url, {
        ...requestInit,
        redirect: "manual",
        signal: controller.signal,
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        if (redirect === maxRedirects)
          throw new AppError("Too many integration redirects", 502, "provider_redirect");
        url = new URL(location, url);
        continue;
      }
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > maxBytes)
        throw new AppError("Provider response is too large", 502, "provider_too_large");
      return response;
    }
    throw new AppError("Integration request failed", 502, "provider_error");
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AppError("Integration request timed out", 504, "provider_timeout");
    }
    throw new AppError("Integration request failed", 502, "provider_error");
  } finally {
    clearTimeout(timeout);
  }
}

export async function readLimitedText(
  response: Response,
  maxBytes = 10_000_000,
  timeoutMs = 20_000,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel("Provider response body timed out").catch(() => undefined);
  }, timeoutMs);
  try {
    while (true) {
      const chunk = await reader.read();
      if (timedOut) {
        throw new AppError("Provider response timed out", 504, "provider_timeout");
      }
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AppError("Provider response is too large", 502, "provider_too_large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    if (timedOut) {
      throw new AppError("Provider response timed out", 504, "provider_timeout");
    }
    return text + decoder.decode();
  } catch (error) {
    if (timedOut) {
      throw new AppError("Provider response timed out", 504, "provider_timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}
