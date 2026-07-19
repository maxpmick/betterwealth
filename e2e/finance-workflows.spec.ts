import { expect, test } from "@playwright/test";
import { authenticatedApi, e2eLabel, expectNoHorizontalOverflow, loginAsAlex } from "./helpers";

function flexibleLabel(value) {
  const terms = value
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(terms.join("[\\s-]+"), "i");
}

async function openTransaction(page, description) {
  const search = page.getByLabel("Search transactions");
  await search.fill(description);
  const row = page
    .locator("button:visible")
    .filter({ hasText: flexibleLabel(description) })
    .first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByRole("heading", { name: "Transaction detail" })).toBeVisible();
}

async function addManualTransaction(page, input) {
  await page.goto("/transactions?action=add");
  const dialog = page.getByRole("dialog", { name: "Add a transaction" });
  await expect(dialog).toBeVisible();
  if (input.account) {
    await dialog.getByRole("combobox", { name: "Account" }).click();
    await page.getByRole("option", { name: new RegExp(input.account, "i") }).click();
  }
  if (input.type === "Income / credit") {
    await dialog.getByRole("combobox", { name: "Type" }).click();
    await page.getByRole("option", { name: "Income / credit" }).click();
  }
  await dialog.getByRole("textbox", { name: /^Amount/ }).fill(input.amount);
  await dialog.getByRole("textbox", { name: "Description" }).fill(input.description);
  if (input.category) {
    await dialog.getByRole("combobox", { name: "Category (optional)" }).click();
    await page.getByRole("option", { name: input.category, exact: true }).click();
  }
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith("/api/v1/transactions") && candidate.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Add transaction" }).click();
  const created = await response;
  expect(created.status()).toBe(201);
  const body = await created.json();
  await expect(dialog).toBeHidden();
  return body.id;
}

test.describe("live finance workflows", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAlex(page);
  });

  test("creates a manual expense and preserves an exact split", async ({ page }, testInfo) => {
    const description = e2eLabel(testInfo, "Cash lunch split");
    const transactionId = await addManualTransaction(page, {
      description,
      amount: "42.37",
      category: "Dining",
    });

    await openTransaction(page, description);
    await page.getByRole("button", { name: "Split transaction" }).click();
    const split = page.getByRole("dialog", { name: "Split transaction" });
    await expect(split.getByText("Every cent is assigned.")).toBeVisible();
    await split.getByRole("combobox", { name: "Split 1 category" }).click();
    await page.getByRole("option", { name: "Dining", exact: true }).click();
    await split.getByRole("combobox", { name: "Split 2 category" }).click();
    await page.getByRole("option", { name: "Groceries", exact: true }).click();
    const saveResponse = page.waitForResponse(
      (candidate) => candidate.url().includes("/splits") && candidate.request().method() === "PUT",
    );
    await split.getByRole("button", { name: "Save split" }).click();
    expect((await saveResponse).status()).toBe(200);
    await expect(split).toBeHidden();
    await expect(page.getByText("2-part split", { exact: true })).toBeVisible();

    const list = await authenticatedApi(page, "GET", "/transactions");
    const created = list.body.data.find((item) => item.id === transactionId);
    expect(created?.hasSplits).toBe(true);
    const detail = await authenticatedApi(page, "GET", `/transactions/${created?.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.splits.map((part) => part.amount.minorUnits)).toEqual(["-2118", "-2119"]);
    expect(detail.body.splits.reduce((sum, part) => sum + BigInt(part.amount.minorUnits), 0n)).toBe(
      -4237n,
    );
    await expectNoHorizontalOverflow(page);
  });

  test("imports a reviewed CSV and deduplicates its stable transaction ID", async ({
    page,
  }, testInfo) => {
    const merchant = e2eLabel(testInfo, "CSV bike repair");
    const externalId = e2eLabel(testInfo, "csv-id").replace(/\s+/g, "-");
    const csv = `date,description,amount,id,memo\n2026-08-02,${merchant},-73.19,${externalId},wheel tune-up\n`;
    await page.goto("/transactions?action=import");
    const dialog = page.getByRole("dialog", { name: "Import transactions" });
    await dialog.getByLabel("Transaction import file").setInputFiles({
      name: `${externalId}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await expect(dialog.getByText("1 estimated transaction row", { exact: false })).toBeVisible();
    const importResponse = page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/v1/imports/transactions") &&
        candidate.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Import 1" }).click();
    expect((await importResponse).status()).toBe(201);
    await expect(dialog.getByText(/1 imported/)).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();

    await page.getByLabel("Search transactions").fill(merchant);
    await expect(
      page
        .locator("button:visible")
        .filter({ hasText: flexibleLabel(merchant) })
        .first(),
    ).toBeVisible();

    await page.getByRole("button", { name: "Import" }).click();
    const duplicateDialog = page.getByRole("dialog", { name: "Import transactions" });
    await duplicateDialog.getByLabel("Transaction import file").setInputFiles({
      name: `${externalId}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    const duplicateResponse = page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/v1/imports/transactions") &&
        candidate.request().method() === "POST",
    );
    await duplicateDialog.getByRole("button", { name: "Import 1" }).click();
    expect((await duplicateResponse).status()).toBe(409);
    await expect(
      duplicateDialog.getByRole("alert").filter({ hasText: /already imported/ }),
    ).toBeVisible();
  });

  test("matches an exact transfer pair and links a bounded refund", async ({ page }, testInfo) => {
    const accountsResponse = await authenticatedApi(page, "GET", "/accounts");
    const checking = accountsResponse.body.data.find(
      (account) => account.name === "Everyday Checking",
    );
    const savings = accountsResponse.body.data.find(
      (account) => account.name === "Emergency Savings",
    );
    expect(checking).toBeDefined();
    expect(savings).toBeDefined();
    const effectiveDate = new Date().toISOString();
    const transferOut = e2eLabel(testInfo, "Move to savings out");
    const transferIn = e2eLabel(testInfo, "Move to savings in");
    const transferAmount = testInfo.project.name.includes("mobile") ? "-31416" : "-27183";
    const create = (accountId, amountMinorUnits, description) =>
      authenticatedApi(page, "POST", "/transactions", {
        accountId,
        amountMinorUnits,
        currency: "USD",
        effectiveDate,
        description,
      });
    if (!checking || !savings) throw new Error("Canonical cash accounts are missing");
    const createdTransferOut = await create(checking.id, transferAmount, transferOut);
    const createdTransferIn = await create(savings.id, String(-BigInt(transferAmount)), transferIn);
    expect(createdTransferOut.status).toBe(201);
    expect(createdTransferIn.status).toBe(201);

    await page.goto("/transactions");
    await openTransaction(page, transferOut);
    await page.getByRole("button", { name: "Match transfer" }).click();
    const transferDialog = page.getByRole("dialog", {
      name: "Match both sides of a transfer",
    });
    const candidate = transferDialog.getByRole("combobox", { name: "Matching transaction" });
    await expect(candidate).toContainText(/Emergency Savings/);
    await transferDialog.getByRole("button", { name: "Confirm transfer match" }).click();
    await expect(transferDialog).toBeHidden();
    await expect(page.getByText("Matched transfer", { exact: true })).toBeVisible();

    const purchase = e2eLabel(testInfo, "Returned headphones");
    const refund = e2eLabel(testInfo, "Headphones partial refund");
    const createdPurchase = await create(checking.id, "-5000", purchase);
    const createdRefund = await create(checking.id, "1200", refund);
    expect(createdPurchase.status).toBe(201);
    expect(createdRefund.status).toBe(201);
    await page.reload();
    await openTransaction(page, purchase);
    await page.getByRole("button", { name: "Link refund" }).click();
    const refundDialog = page.getByRole("dialog", { name: "Find a refund for this purchase" });
    const refundCandidate = refundDialog.getByRole("combobox", { name: "Refund credit" });
    await refundCandidate.click();
    const refundOption = page.getByRole("option", { name: flexibleLabel(refund) });
    await expect(refundOption).toBeVisible();
    await refundOption.click();
    await expect(refundCandidate).toContainText(flexibleLabel(refund));
    await refundDialog.getByRole("button", { name: "Confirm refund link" }).click();
    await expect(refundDialog).toBeHidden();
    await expect(page.getByText("1 refund link", { exact: true })).toBeVisible();

    const list = await authenticatedApi(page, "GET", "/transactions");
    expect(list.body.data.find((item) => item.id === createdTransferOut.body.id)?.isTransfer).toBe(
      true,
    );
    expect(
      list.body.data.find((item) => item.id === createdTransferIn.body.id)?.transferId,
    ).toBeTruthy();
    expect(
      list.body.data.find((item) => item.id === createdPurchase.body.id)?.refundLinkIds,
    ).toHaveLength(1);
  });

  test("creates a paycheck envelope with a deterministic merchant rule and funds the plan", async ({
    page,
  }, testInfo) => {
    const envelopeName = e2eLabel(testInfo, "Career conference");
    const matchText = e2eLabel(testInfo, "CONFERENCE PASS");
    await page.goto("/budget?action=add-envelope");
    const dialog = page.getByRole("dialog", { name: "New envelope" });
    await dialog.getByRole("textbox", { name: "Envelope name" }).fill(envelopeName);
    await dialog.getByRole("textbox", { name: "Target per paycheck" }).fill("125.50");
    await dialog.getByRole("combobox", { name: "Category match" }).click();
    await page.getByRole("option", { name: "Dining", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Optional transaction rule" }).fill(matchText);
    await dialog.getByRole("checkbox", { name: "Required bill or essential spending" }).check();
    const createResponse = page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/v1/envelopes") && candidate.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Save envelope" }).click();
    expect((await createResponse).status()).toBe(201);
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: envelopeName })).toBeVisible();

    const envelopes = await authenticatedApi(page, "GET", "/envelopes");
    expect(envelopes.body.data.find((item) => item.name === envelopeName)).toMatchObject({
      planned: { minorUnits: "12550", currency: "USD" },
      isRequired: true,
    });
    const rules = await authenticatedApi(page, "GET", "/rules");
    expect(rules.body.data.some((rule) => rule.name === `${matchText} → ${envelopeName}`)).toBe(
      true,
    );

    await page.getByRole("button", { name: "Fund paycheck" }).click();
    const funding = page.getByRole("dialog", { name: /Fund / });
    const updateResponse = page.waitForResponse(
      (candidate) =>
        /\/api\/v1\/budgets\/[^/]+$/.test(new URL(candidate.url()).pathname) &&
        candidate.request().method() === "PATCH",
    );
    await funding.getByRole("button", { name: "Commit allocation" }).click();
    expect((await updateResponse).status()).toBe(200);
    await expect(funding).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });

  test("creates and revalues an asset, then reconciles a manual account", async ({
    page,
  }, testInfo) => {
    const assetName = e2eLabel(testInfo, "First paid-off car");
    await page.goto("/net-worth");
    await page.getByRole("button", { name: "Add asset", exact: true }).click();
    const assetDialog = page.getByRole("dialog", { name: "Add a valued asset" });
    await assetDialog.getByRole("textbox", { name: "Asset name" }).fill(assetName);
    await assetDialog.getByRole("textbox", { name: "Current value" }).fill("10000");
    await assetDialog.getByRole("button", { name: "Add asset" }).click();
    await expect(assetDialog).toBeHidden();
    const assetCard = page
      .getByRole("heading", { name: assetName })
      .locator("xpath=ancestor::*[contains(@class, 'MuiCard-root')][1]");
    await expect(assetCard).toContainText("$10,000");
    await assetCard.getByRole("button", { name: "Update value" }).click();
    const valuationDialog = page.getByRole("dialog", { name: "Record a new valuation" });
    await valuationDialog.getByRole("textbox", { name: "Estimated value" }).fill("11250.25");
    await valuationDialog.getByRole("combobox", { name: "Source" }).click();
    await page.getByRole("option", { name: "Appraisal" }).click();
    await valuationDialog.getByRole("button", { name: "Record valuation" }).click();
    await expect(valuationDialog).toBeHidden();
    await expect(assetCard).toContainText("$11,250.25");

    const assets = await authenticatedApi(page, "GET", "/assets");
    const asset = assets.body.data.find((item) => item.name === assetName);
    expect(asset?.value.minorUnits).toBe("1125025");
    const valuations = await authenticatedApi(page, "GET", `/assets/${asset?.id}/valuations`);
    expect(valuations.body.data.map((item) => item.amount.minorUnits)).toContain("1125025");

    const accountName = e2eLabel(testInfo, "Freelance cash reserve");
    await page.goto("/accounts?action=add");
    const chooser = page.getByRole("dialog", { name: "Add account or asset" });
    await chooser.getByRole("button", { name: /Manual account/ }).click();
    const accountDialog = page.getByRole("dialog", { name: "Add manual account" });
    await accountDialog.getByRole("textbox", { name: "Name" }).fill(accountName);
    await accountDialog.getByRole("textbox", { name: "Opening balance" }).fill("1234.56");
    await accountDialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(accountDialog).toBeHidden();
    await page.getByRole("button", { name: new RegExp(accountName) }).click();
    const accountDrawer = page.getByRole("presentation");
    const recorded = accountDrawer.getByRole("textbox", { name: "Recorded balance" });
    await expect(recorded).toHaveValue("1234.56");
    await recorded.fill("1400.01");
    await accountDrawer.getByRole("button", { name: "Save changes" }).click();
    await expect(accountDrawer).toBeHidden();

    const accounts = await authenticatedApi(page, "GET", "/accounts");
    const account = accounts.body.data.find((item) => item.name === accountName);
    expect(account?.balance.minorUnits).toBe("140001");
    const history = await authenticatedApi(page, "GET", `/accounts/${account?.id}/balances`);
    expect(history.body.data.at(-1)?.current.minorUnits).toBe("140001");
  });

  test("previews, applies, edits, and persists a deterministic automation rule", async ({
    page,
  }, testInfo) => {
    const accounts = await authenticatedApi(page, "GET", "/accounts");
    const checking = accounts.body.data.find((account) => account.name === "Everyday Checking");
    const merchant = e2eLabel(testInfo, "Certification exam");
    if (!checking) throw new Error("Canonical checking account is missing");
    const created = await authenticatedApi(page, "POST", "/transactions", {
      accountId: checking.id,
      amountMinorUnits: "-19900",
      currency: "USD",
      effectiveDate: new Date().toISOString(),
      description: merchant,
    });
    expect(created.status).toBe(201);

    const ruleName = e2eLabel(testInfo, "Career investment rule");
    const normalizedPattern = merchant.replaceAll("-", " ");
    await page.goto("/automation?action=add");
    const builder = page.getByRole("presentation");
    await expect(page.getByRole("heading", { name: "New rule" })).toBeVisible();
    await builder.getByRole("textbox", { name: "Rule name" }).fill(ruleName);
    await builder.getByRole("combobox", { name: "Condition 1 field" }).click();
    await page.getByRole("option", { name: "Description" }).click();
    await builder.getByRole("textbox", { name: "Description text" }).fill(normalizedPattern);
    await builder.getByRole("combobox", { name: "Action 1 category" }).click();
    await page.getByRole("option", { name: /Dining · expense/ }).click();
    await builder.getByRole("button", { name: "Run preview" }).click();
    await expect(builder.getByText("1 historical match", { exact: false })).toBeVisible();
    await builder.getByLabel(/Apply to these 1 existing match/).check();
    await builder.getByRole("button", { name: "Save rule" }).click();
    await expect(page.getByRole("heading", { name: "New rule" })).toBeHidden();
    await expect(page.getByText(ruleName, { exact: true })).toBeVisible();

    const transaction = await authenticatedApi(page, "GET", "/transactions");
    expect(transaction.body.data.find((item) => item.id === created.body.id)?.categoryName).toBe(
      "Dining",
    );

    const editedName = `${ruleName} updated`;
    await page.getByRole("button", { name: `Edit ${ruleName}` }).click();
    const editor = page.getByRole("presentation");
    await editor.getByRole("textbox", { name: "Rule name" }).fill(editedName);
    await expect(editor.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await editor.getByRole("button", { name: "Run preview" }).click();
    await expect(editor.getByText("1 historical match", { exact: false })).toBeVisible();
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(editedName, { exact: true })).toBeVisible();
    const rules = await authenticatedApi(page, "GET", "/rules");
    expect(rules.body.data.some((rule) => rule.name === editedName)).toBe(true);
    await expectNoHorizontalOverflow(page);
  });
});
