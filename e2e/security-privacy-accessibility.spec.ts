import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  alexCredentials,
  authenticatedApi,
  e2eLabel,
  expectNoHorizontalOverflow,
  loginAsAlex,
} from "./helpers";

test.describe("security, privacy, and inclusive interaction", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAlex(page);
  });

  test("stores only a synthetic provider key and excludes it from a portable export", async ({
    page,
  }, testInfo) => {
    const syntheticKey = e2eLabel(testInfo, "e2e-synthetic-key-never-send").replace(/\s+/g, "-");
    await page.goto("/settings?section=integrations");
    const consent = page.getByLabel("Allow bounded AI categorization requests");
    if (!(await consent.isChecked())) {
      await consent.check();
    } else {
      await page.getByRole("button", { name: /Edit configuration|Configure/ }).click();
    }
    const dialog = page.getByRole("dialog", { name: "Configure AI categorization" });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("textbox", { name: "OpenAI-compatible base URL" })
      .fill("https://openrouter.ai/api/v1");
    await dialog.getByRole("textbox", { name: "Model" }).fill("tencent/hy3:free");
    await dialog.getByLabel(/API key|Replace API key/).fill(syntheticKey);
    const save = page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/v1/settings/integrations/ai") &&
        candidate.request().method() === "PUT",
    );
    await dialog.getByRole("button", { name: "Save encrypted configuration" }).click();
    expect((await save).status()).toBe(200);
    await expect(dialog).toBeHidden();
    await expect(page.getByText(syntheticKey, { exact: false })).toHaveCount(0);

    const config = await authenticatedApi(page, "GET", "/settings/integrations/ai");
    expect(config.body).toMatchObject({
      configured: true,
      enabled: true,
      model: "tencent/hy3:free",
    });
    expect(config.body).not.toHaveProperty("apiKey");

    await page.goto("/settings?section=data");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download JSON export" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^betterwealth-\d{4}-\d{2}-\d{2}\.json$/);
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    if (!downloadPath) throw new Error("Portable export did not produce a local file");
    const text = await readFile(downloadPath, "utf8");
    const exported = JSON.parse(text);
    expect(exported.format).toBe("betterwealth-export-v1");
    expect(exported).toHaveProperty("integrity");
    expect(Array.isArray(exported.accounts)).toBe(true);
    expect(Array.isArray(exported.transactions)).toBe(true);
    expect(Array.isArray(exported.goals)).toBe(true);
    expect(text).not.toContain(syntheticKey);
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("credentialsCiphertext");
    await expect(page.getByText(/Downloaded betterwealth-.*\.json/)).toBeVisible();
  });

  test("lists the current session and revokes another browser session", async ({
    page,
    browser,
  }, testInfo) => {
    const secondContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    const secondPage = await secondContext.newPage();
    try {
      await loginAsAlex(secondPage, { forceNewSession: true });
      await page.goto("/settings?section=security");
      await expect(page.getByText("Current", { exact: true })).toBeVisible();
      const revokeAll = page.getByRole("button", { name: "Revoke all other sessions" });
      await expect(revokeAll).toBeEnabled();
      const revoked = page.waitForResponse(
        (candidate) =>
          candidate.url().includes("/api/v1/auth/sessions/") &&
          candidate.request().method() === "DELETE" &&
          candidate.status() === 204,
      );
      await revokeAll.click();
      await revoked;
      await expect
        .poll(async () =>
          secondPage.evaluate(async () => {
            const response = await fetch("/api/v1/auth/session", {
              credentials: "same-origin",
            });
            return response.status;
          }),
        )
        .toBe(401);
    } finally {
      await secondContext.close();
    }
  });

  test("keeps privacy masking persistent and truthful to assistive technology", async ({
    page,
  }) => {
    await expect(page.getByText("$600.25", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Hide monetary values" }).click();
    await expect(page.getByLabel("Amount hidden").first()).toBeVisible();
    await expect(page.getByText("$600.25", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show monetary values" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.reload();
    await expect(page.getByLabel("Amount hidden").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Show monetary values" })).toBeVisible();
    await page.getByRole("button", { name: "Show monetary values" }).click();
    await expect(page.getByText("$600.25", { exact: true }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("supports keyboard search and restores focus when overlays close", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: /Good (morning|afternoon|evening), Alex/ }),
    ).toBeVisible();
    await page.keyboard.press("Control+K");
    const commandDialog = page.getByRole("dialog", { name: "Find anything" });
    await expect(commandDialog).toBeVisible();
    await expect(commandDialog.getByRole("textbox", { name: "Search BetterWealth" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(commandDialog).toBeHidden();

    const searchTrigger = page
      .locator('button[aria-label="Search BetterWealth"]:visible, button:visible')
      .filter({ hasText: /^Search$/ })
      .first();
    if (await searchTrigger.isVisible()) {
      await searchTrigger.click();
      await expect(commandDialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(searchTrigger).toBeFocused();
    }

    await page.goto("/transactions");
    const add = page.getByRole("button", { name: "Add transaction" });
    await add.focus();
    await add.press("Enter");
    const addDialog = page.getByRole("dialog", { name: "Add a transaction" });
    await expect(addDialog).toBeVisible();
    expect(await addDialog.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    await expect(addDialog).toBeHidden();
    await expect(add).toBeFocused();
  });

  test("has no serious WCAG violations or mobile overflow on critical money pages", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const routes = [
      ["/today", /Good (morning|afternoon|evening), Alex/],
      ["/transactions", /Transactions/],
      ["/budget", /A job for every dollar/],
      ["/goals", /Turn surplus into options/],
      ["/net-worth", /Net worth, without the blur/],
      ["/forecast", /See where today’s plan can lead/],
      ["/automation", /Trust is earned one narrow rule at a time/],
      ["/settings?section=security", /Security/],
    ];

    for (const [route, heading] of routes) {
      await page.goto(route);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        // MUI X 9.9 creates empty, hidden voiceover proxy images until a chart point receives
        // keyboard focus. The surrounding summary and expandable data table remain in the scan.
        .exclude('div[role="img"][aria-labelledby^="voiceover-"]')
        .analyze();
      const serious = result.violations.filter(
        (violation) => violation.impact === "serious" || violation.impact === "critical",
      );
      expect(
        serious,
        `${route}: ${serious
          .map(
            (violation) =>
              `${violation.id} (${violation.nodes.map((node) => node.target.join(" ")).join(", ")})`,
          )
          .join("; ")}`,
      ).toEqual([]);
    }
  });
});

test.describe("authentication boundary", () => {
  test("does not reveal whether a failed login email exists", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email address").fill(alexCredentials.email);
    await page.locator('input[name="password"]').fill("definitely-not-the-password");
    const response = page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/v1/auth/login") && candidate.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Sign in" }).click();
    expect((await response).status()).toBe(401);
    await expect(page.getByRole("alert")).toContainText(/email or password/i);
    await expect(page).toHaveURL(/\/login$/);
  });
});
