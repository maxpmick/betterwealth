import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, loginAsAlex, patchTransactionByMerchant } from "./helpers";

test.describe("Alex's age-22 path to wealth at 30", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAlex(page);
  });

  test("signs in to a trustworthy Today view with live financial data", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Good morning, Alex" })).toBeVisible();
    await expect(page.getByText("Safe to spend", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/per day/).first()).toBeVisible();

    await page.getByRole("button", { name: "Show how this is calculated" }).click();
    await expect(page.getByText(/Available cash/)).toBeVisible();
    await expect(page.getByText(/Min\. buffer/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("reviews a new merchant and persists its category through the API contract", async ({
    page,
  }) => {
    const reset = await patchTransactionByMerchant(page, "Metro Transit", {
      categoryName: "Uncategorized",
      reviewState: "needs_review",
    });
    expect(reset.status).toBe(200);

    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/transactions") && response.request().method() === "GET",
    );
    await page.goto("/transactions");
    expect((await responsePromise).status()).toBe(200);
    await page.getByLabel("Search transactions").fill("Metro Transit");
    await page.locator("button:visible").filter({ hasText: "Metro Transit" }).first().click();
    await expect(page.getByRole("heading", { name: "Transaction detail" })).toBeVisible();

    await page.getByRole("combobox", { name: "Category" }).click();
    await page.getByRole("option", { name: "Groceries" }).click();
    await page.getByRole("button", { name: "Save & approve" }).click();
    await expect(page.getByRole("heading", { name: "Transaction detail" })).toBeHidden();

    const persisted = await patchTransactionByMerchant(page, "Metro Transit", {
      categoryName: "Groceries",
      reviewState: "approved",
    });
    expect(persisted.status).toBe(200);
    expect(persisted.body.categoryName).toBe("Groceries");

    await page.reload();
    await page.getByLabel("Search transactions").fill("Metro Transit");
    const row = page.locator("button:visible").filter({ hasText: "Metro Transit" }).first();
    await expect(row).toBeVisible();
    await expect(row.locator("xpath=../..")).toContainText("Groceries");
  });

  test("loads the seeded paycheck budget and previews funding", async ({ page }) => {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/budgets") && response.request().method() === "GET",
    );
    await page.goto("/budget");
    expect((await responsePromise).status()).toBe(200);
    await expect(page.getByRole("heading", { name: "A job for every dollar" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Rent" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Groceries" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Emergency Fund" })).toBeVisible();

    await page.getByRole("button", { name: "Fund paycheck" }).click();
    await expect(page.getByRole("heading", { name: /^Fund / })).toBeVisible();
    await expect(page.getByText("Funding source", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review later" }).click();
    await expect(page.getByRole("heading", { name: /^Fund / })).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });

  test("compares a comfortable purchase goal and an age-30 forecast", async ({ page }) => {
    await page.goto("/goals");
    await expect(page.getByRole("heading", { name: "Turn surplus into options" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /emergency fund/i }).first()).toBeVisible();
    await page.getByRole("button", { name: "What if" }).first().click();
    await expect(page.getByRole("heading", { name: /test the plan/ })).toBeVisible();
    await expect(page.getByText("Projected funding date", { exact: true })).toBeVisible();
    const monthlyPace = page.getByRole("textbox", { name: "What-if monthly pace" });
    await monthlyPace.fill("900");
    await expect(page.getByText("$900.00", { exact: true })).toBeVisible();
    await expect(page.getByText(/month.*sooner|Same month/)).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();

    await page.goto("/forecast");
    await expect(
      page.getByRole("heading", { name: "See where today’s plan can lead" }),
    ).toBeVisible();
    await expect(page.getByText("Liquid cash at horizon", { exact: true })).toBeVisible();
    await expect(page.getByText("Total net worth at horizon", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: /Alex accelerated path/ }).click();
    await expect(page.getByRole("tab", { name: /Alex accelerated path/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expectNoHorizontalOverflow(page);
  });

  test("creates, funds, edits, and archives a real savings goal", async ({ page }) => {
    await page.goto("/goals?action=add");
    const createDialog = page.getByRole("dialog", { name: "Create a goal" });
    await expect(createDialog).toBeVisible();
    await createDialog.getByRole("textbox", { name: "Goal name" }).fill("Laptop without debt");
    await createDialog.getByRole("textbox", { name: "Target amount" }).fill("1800");
    await createDialog.getByRole("textbox", { name: "Already saved" }).fill("200");
    await createDialog.getByRole("textbox", { name: "Monthly contribution" }).fill("200");
    await createDialog.getByLabel("Target date").fill("2027-04-01");
    await createDialog.getByRole("button", { name: "Create goal" }).click();

    const goalCard = page
      .getByRole("heading", { name: "Laptop without debt" })
      .locator("xpath=ancestor::*[contains(@class, 'MuiCard-root')][1]");
    await expect(goalCard).toBeVisible();
    await expect(goalCard).toContainText("$200");
    await goalCard.getByRole("button", { name: "Fund" }).click();
    const fundingDialog = page.getByRole("dialog", { name: "Fund Laptop without debt" });
    await expect(fundingDialog.getByText(/does not initiate a bank transfer/)).toBeVisible();
    await fundingDialog.getByRole("textbox", { name: "Note" }).fill("Paycheck surplus");
    await fundingDialog.getByRole("button", { name: "Record contribution" }).click();
    await expect(fundingDialog).toBeHidden();
    await expect(goalCard).toContainText("$400");

    await goalCard.getByRole("button", { name: "Edit Laptop without debt" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit goal" });
    await editDialog.getByRole("button", { name: "Archive" }).click();
    const archiveDialog = page.getByRole("dialog", { name: "Archive Laptop without debt?" });
    await expect(archiveDialog.getByText(/contribution history stays/)).toBeVisible();
    await archiveDialog.getByRole("button", { name: "Archive goal" }).click();
    await expect(editDialog).toBeHidden();
    await expect(page.getByRole("heading", { name: "Laptop without debt" })).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });
});
