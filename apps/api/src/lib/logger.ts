const SECRET_KEY_PATTERN =
  /(authorization|cookie|password|secret|token|access.?url|api.?key|credential)/i;
const URL_CREDENTIAL_PATTERN = /(https?:\/\/)[^/@\s]+@/gi;
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const AUTHORIZATION_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return value
      .replace(URL_CREDENTIAL_PATTERN, "$1[REDACTED]@")
      .replace(API_KEY_PATTERN, "[REDACTED]")
      .replace(AUTHORIZATION_PATTERN, "$1 [REDACTED]");
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redact(entry, seen),
      ]),
    );
  }
  return value;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export function createLogger(minimum: LogLevel = "info") {
  const ranking: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ranking[level] < ranking[minimum]) return;
    const record = {
      time: new Date().toISOString(),
      level,
      message,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    const line = JSON.stringify(record);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
    info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
    error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
  };
}
