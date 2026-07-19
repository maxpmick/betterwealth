import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type BrowserContext, chromium, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:5173";
const outputDirectory = resolve(import.meta.dir, "../docs/screenshots");

async function signIn(page: Page) {
  await page.goto(`${origin}/login`);
  await page.getByLabel("Email address").fill("alex@example.com");
  await page.locator('input[name="password"]').fill("WealthBy30!2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${origin}/today`);
  await page.getByRole("heading", { name: /Good (morning|afternoon|evening), Alex/ }).waitFor();
}

async function capture(
  page: Page,
  path: string,
  heading: RegExp,
  readyText: string,
  suffix: string,
) {
  await page.goto(`${origin}${path}`);
  await page.getByRole("heading", { level: 1, name: heading }).waitFor();
  await page.getByText(readyText, { exact: true }).first().waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: resolve(
      outputDirectory,
      `betterwealth-${path.slice(1)}${suffix ? `-${suffix}` : ""}.png`,
    ),
    fullPage: suffix === "",
    animations: "disabled",
  });
}

async function captureViewport(context: BrowserContext, suffix: string) {
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await capture(page, "/today", /Good (morning|afternoon|evening), Alex/, "Safe to spend", suffix);
  await capture(page, "/budget", /Budget/, "Paycheck funding plan", suffix);
  await capture(page, "/goals", /Goals/, "Monthly committed", suffix);
  await page.close();
}

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch();
try {
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
    timezoneId: "America/New_York",
    colorScheme: "light",
  });
  const loginPage = await desktop.newPage();
  await signIn(loginPage);
  await loginPage.close();
  await captureViewport(desktop, "");
  const cookies = await desktop.cookies();
  await desktop.close();

  const mobile = await browser.newContext({
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
    locale: "en-US",
    timezoneId: "America/New_York",
    colorScheme: "light",
  });
  await mobile.addCookies(cookies);
  await captureViewport(mobile, "mobile");
  await mobile.close();
} finally {
  await browser.close();
}
