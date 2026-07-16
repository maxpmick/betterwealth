import { expect, type Page, type TestInfo } from "@playwright/test";

export const alexCredentials = {
  email: "alex@example.com",
  password: "WealthBy30!2026",
} as const;

type BrowserCookies = Parameters<ReturnType<Page["context"]>["addCookies"]>[0];
let reusableAlexCookies: BrowserCookies | undefined;

export async function loginAsAlex(page: Page, options: { forceNewSession?: boolean } = {}) {
  if (!options.forceNewSession && reusableAlexCookies) {
    await page.context().addCookies(reusableAlexCookies);
    await page.goto("/today");
  } else {
    await page.goto("/login");
    await page.getByLabel("Email address").fill(alexCredentials.email);
    await page.locator('input[name="password"]').fill(alexCredentials.password);
    const loginResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/auth/login") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Sign in" }).click();
    expect((await loginResponse).status()).toBe(200);
    await expect(page).toHaveURL(/\/today$/);
    if (!options.forceNewSession) reusableAlexCookies = await page.context().cookies();
  }

  const session = await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/session", { credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  });
  expect(session.status).toBe(200);
  expect(session.body.user.email).toBe(alexCredentials.email);
}

export async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
}

/**
 * Keeps records created by mutating journeys distinct across projects and retries. The E2E server
 * starts from a fresh canonical Alex database, while desktop and mobile intentionally share that
 * server so cross-device behavior is exercised against the same API contract.
 */
export function e2eLabel(testInfo: TestInfo, label: string) {
  const project = testInfo.project.name.replace(/[^a-z0-9]+/gi, "-");
  return `${label} ${project} r${testInfo.retry}`;
}

export interface ApiResult<T> {
  status: number;
  body: T;
}

/** Browser-authenticated API request for arranging or independently verifying UI journeys. */
export async function authenticatedApi<T>(
  page: Page,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  return page.evaluate(
    async ({ requestMethod, requestPath, requestBody }) => {
      const csrf = document.cookie
        .split("; ")
        .find((entry) => entry.startsWith("bw_csrf="))
        ?.slice("bw_csrf=".length);
      const headers = new Headers({ Accept: "application/json" });
      if (requestBody !== undefined) headers.set("Content-Type", "application/json");
      if (!["GET", "HEAD", "OPTIONS"].includes(requestMethod)) {
        if (!csrf) throw new Error("Missing CSRF cookie");
        headers.set("X-CSRF-Token", decodeURIComponent(csrf));
        headers.set("Idempotency-Key", crypto.randomUUID());
      }
      const response = await fetch(`/api/v1${requestPath}`, {
        method: requestMethod,
        credentials: "same-origin",
        headers,
        ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
      });
      let responseBody: unknown = null;
      if (response.status !== 204) responseBody = await response.json();
      return { status: response.status, body: responseBody };
    },
    { requestMethod: method, requestPath: path, requestBody: body },
  ) as Promise<ApiResult<T>>;
}

export async function patchTransactionByMerchant(
  page: Page,
  merchant: string,
  patch: Record<string, unknown>,
) {
  return page.evaluate(
    async ({ merchantName, transactionPatch }) => {
      const listResponse = await fetch("/api/v1/transactions", { credentials: "same-origin" });
      if (!listResponse.ok) throw new Error(`Transaction list failed with ${listResponse.status}`);
      const list = (await listResponse.json()) as { data: Array<{ id: string; merchant: string }> };
      const transaction = list.data.find((item) => item.merchant === merchantName);
      if (!transaction) throw new Error(`Could not find ${merchantName}`);
      const csrf = document.cookie
        .split("; ")
        .find((entry) => entry.startsWith("bw_csrf="))
        ?.slice("bw_csrf=".length);
      if (!csrf) throw new Error("Missing CSRF cookie");
      const response = await fetch(`/api/v1/transactions/${encodeURIComponent(transaction.id)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": decodeURIComponent(csrf),
        },
        body: JSON.stringify(transactionPatch),
      });
      return { status: response.status, body: await response.json() };
    },
    { merchantName: merchant, transactionPatch: patch },
  );
}
