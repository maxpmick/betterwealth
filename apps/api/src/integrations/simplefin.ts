import { z } from "zod";
import { readLimitedText, safeFetch } from "../lib/egress";
import { AppError } from "../lib/errors";

// BetterWealth currently integrates with the operated SimpleFIN Bridge, not arbitrary protocol
// servers. Keeping this allowlist explicit prevents an authenticated setup token from becoming a
// blind POST/Basic-Auth SSRF primitive. Add a host only after reviewing its operator and contract.
export const SIMPLEFIN_BRIDGE_HOSTS = new Set([
  "bridge.simplefin.org",
  "beta-bridge.simplefin.org",
]);

const transactionSchema = z.object({
  id: z.string(),
  posted: z.number(),
  amount: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  description: z.string(),
  transacted_at: z.number().optional(),
  pending: z.boolean().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  conn_id: z.string().optional(),
  currency: z.string(),
  balance: z.string().regex(/^-?\d+(?:\.\d+)?$/),
  "available-balance": z
    .string()
    .regex(/^-?\d+(?:\.\d+)?$/)
    .optional(),
  "balance-date": z.number(),
  transactions: z.array(transactionSchema).optional().default([]),
  extra: z.record(z.string(), z.unknown()).optional(),
  org: z
    .object({
      domain: z.string().optional(),
      name: z.string().optional(),
      "sfin-url": z.string().optional(),
    })
    .optional(),
});

const connectionSchema = z.object({
  conn_id: z.string(),
  name: z.string(),
  org_id: z.string(),
  org_name: z.string().optional(),
  org_url: z.string().optional(),
  sfin_url: z.string(),
});

const responseSchema = z.object({
  errlist: z
    .array(
      z.object({
        code: z.string(),
        msg: z.string(),
        conn_id: z.string().optional(),
        account_id: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
  errors: z.array(z.string()).optional().default([]),
  connections: z.array(connectionSchema).optional().default([]),
  accounts: z.array(accountSchema),
});

export type SimpleFinAccountSet = z.infer<typeof responseSchema>;

export function decodeSetupToken(setupToken: string): URL {
  let decoded: string;
  try {
    decoded = Buffer.from(setupToken.trim(), "base64").toString("utf8");
  } catch {
    throw new AppError("The SimpleFIN setup token is not valid Base64", 400, "invalid_setup_token");
  }
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    throw new AppError(
      "The SimpleFIN setup token does not contain a valid URL",
      400,
      "invalid_setup_token",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !SIMPLEFIN_BRIDGE_HOSTS.has(url.hostname.toLowerCase()) ||
    !url.pathname.startsWith("/simplefin/claim/")
  ) {
    throw new AppError("The SimpleFIN claim URL is not valid", 400, "invalid_setup_token");
  }
  return url;
}

export async function claimSimpleFinToken(setupToken: string): Promise<string> {
  const claimUrl = decodeSetupToken(setupToken);
  const response = await safeFetch(claimUrl, {
    method: "POST",
    allowedHosts: SIMPLEFIN_BRIDGE_HOSTS,
    maxBytes: 8_192,
    maxRedirects: 0,
  });
  if (response.status === 403) {
    throw new AppError(
      "SimpleFIN rejected this one-time token. Disable it in SimpleFIN because it may already have been claimed.",
      400,
      "simplefin_token_claimed",
    );
  }
  if (!response.ok)
    throw new AppError("SimpleFIN could not claim this token", 502, "simplefin_claim_failed");
  const accessUrlValue = (await readLimitedText(response, 8_192)).trim();
  let accessUrl: URL;
  try {
    accessUrl = new URL(accessUrlValue);
  } catch {
    throw new AppError(
      "SimpleFIN returned an invalid access URL",
      502,
      "simplefin_invalid_response",
    );
  }
  if (
    accessUrl.protocol !== "https:" ||
    !accessUrl.username ||
    !accessUrl.password ||
    !SIMPLEFIN_BRIDGE_HOSTS.has(accessUrl.hostname.toLowerCase())
  ) {
    throw new AppError(
      "SimpleFIN returned an unsafe access URL",
      502,
      "simplefin_invalid_response",
    );
  }
  return accessUrl.toString();
}

export async function fetchSimpleFinAccounts(
  accessUrlValue: string,
  options: { startDate?: number; endDate?: number; pending?: boolean; balancesOnly?: boolean } = {},
): Promise<SimpleFinAccountSet> {
  const accessUrl = new URL(accessUrlValue);
  const accountsUrl = new URL(`${accessUrl.pathname.replace(/\/$/, "")}/accounts`, accessUrl);
  const username = decodeURIComponent(accessUrl.username);
  const password = decodeURIComponent(accessUrl.password);
  accountsUrl.username = "";
  accountsUrl.password = "";
  accountsUrl.searchParams.set("version", "2");
  if (options.startDate !== undefined)
    accountsUrl.searchParams.set("start-date", String(options.startDate));
  if (options.endDate !== undefined)
    accountsUrl.searchParams.set("end-date", String(options.endDate));
  if (options.pending ?? true) accountsUrl.searchParams.set("pending", "1");
  if (options.balancesOnly) accountsUrl.searchParams.set("balances-only", "1");

  const response = await safeFetch(accountsUrl, {
    allowedHosts: SIMPLEFIN_BRIDGE_HOSTS,
    maxBytes: 25_000_000,
    maxRedirects: 0,
    timeoutMs: 45_000,
    headers: {
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    },
  });
  if (response.status === 402)
    throw new AppError("SimpleFIN requires payment or renewal", 402, "simplefin_payment_required");
  if (response.status === 403)
    throw new AppError("SimpleFIN access was revoked or expired", 409, "simplefin_reauth_required");
  if (!response.ok) throw new AppError("SimpleFIN sync failed", 502, "simplefin_sync_failed");
  const body = await readLimitedText(response, 25_000_000);
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    throw new AppError("SimpleFIN returned malformed data", 502, "simplefin_invalid_response");
  }
  const parsed = responseSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AppError(
      "SimpleFIN returned data in an unsupported format",
      502,
      "simplefin_invalid_response",
    );
  }
  return parsed.data;
}
