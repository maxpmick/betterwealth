import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApiAccount,
  ApiCategory,
  ApiEnvelope,
  ApiTransaction,
  ApiTransactionDetail,
  CursorPage,
} from "../api";
import { AppProviders } from "../contexts";
import {
  CreateTransactionRuleDialog,
  displayItems,
  ImportTransactionsDialog,
  LinkRefundDialog,
  ManualTransactionDialog,
  MatchTransferDialog,
  matchesTransactionFilters,
  parsePositiveCurrencyMinorUnits,
  SplitTransactionDialog,
  TransactionDetail,
  type TransactionView,
} from "../pages/TransactionsPage";

const category: ApiCategory = {
  id: "category-groceries",
  name: "Groceries",
  parentId: null,
  kind: "expense",
  active: true,
};

const envelope: ApiEnvelope = {
  id: "envelope-groceries",
  name: "Groceries",
  planned: { minorUnits: "50000", currency: "USD" },
  funded: { minorUnits: "50000", currency: "USD" },
  activity: { minorUnits: "-1000", currency: "USD" },
  available: { minorUnits: "49000", currency: "USD" },
  transferredIn: { minorUnits: "0", currency: "USD" },
  transferredOut: { minorUnits: "0", currency: "USD" },
  minimumAmount: { minorUnits: "0", currency: "USD" },
  targetAmount: { minorUnits: "50000", currency: "USD" },
  cadence: "monthly",
  pacing: "on_track",
  rolloverPolicy: "positive",
  parentId: null,
  categoryId: category.id,
  categoryIds: [category.id],
  priority: 100,
  isRequired: false,
  isActive: true,
};

const account: ApiAccount = {
  id: "account-checking",
  name: "Everyday checking",
  mask: "2401",
  group: "cash",
  balance: { minorUnits: "300000", currency: "USD" },
  syncStatus: "healthy",
  updatedAt: "2026-07-16T12:00:00.000Z",
};

function transaction(
  patch: Partial<TransactionView> & Pick<TransactionView, "id" | "amountMinorUnits">,
): TransactionView {
  const { id, amountMinorUnits, ...overrides } = patch;
  return {
    id,
    accountId: "account-checking",
    effectiveDate: "2026-07-16T12:00:00.000Z",
    date: "Today",
    merchant: "Corner Market",
    rawDescription: "CORNER MARKET #104",
    account: "Everyday checking",
    accountMask: "2401",
    category: "Groceries",
    envelope: "Groceries",
    amount: Number(amountMinorUnits) / 100,
    amountMinorUnits,
    currency: "USD",
    status: "posted",
    source: "simplefin",
    tags: [],
    isTransfer: false,
    isIncome: false,
    hasSplits: false,
    refundLinkIds: [],
    refundLinkMatches: [],
    provenance: "SimpleFIN import",
    ...overrides,
  };
}

function transactionDetail(
  item: TransactionView,
  patch: Partial<ApiTransactionDetail> = {},
): ApiTransactionDetail {
  return {
    id: item.id,
    effectiveDate: item.effectiveDate,
    description: item.rawDescription,
    merchant: item.merchant,
    amount: { minorUnits: item.amountMinorUnits, currency: item.currency },
    accountId: "account-checking",
    accountName: item.account,
    categoryId: category.id,
    categoryName: item.category,
    envelopeId: envelope.id,
    status: item.status,
    reviewState: "needs_review",
    source: "manual",
    tags: [],
    splits: [],
    transfer: null,
    refundLinks: [],
    ...patch,
  };
}

function renderWithProviders(node: React.ReactNode) {
  return render(<AppProviders>{node}</AppProviders>);
}

describe("transaction actions", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it("parses currency amounts without floating-point rounding", () => {
    expect(parsePositiveCurrencyMinorUnits("$1,234.56")).toBe(123456n);
    expect(parsePositiveCurrencyMinorUnits("0.01")).toBe(1n);
    expect(parsePositiveCurrencyMinorUnits("1.001")).toBeNull();
    expect(parsePositiveCurrencyMinorUnits("0.00")).toBeNull();
  });

  it("maps live ledger truth without fabricating envelope, recurrence, or provenance", () => {
    const page: CursorPage<ApiTransaction> = {
      data: [
        {
          id: "live-removed",
          accountId: "account-live",
          effectiveDate: "2026-07-15T10:00:00.000Z",
          description: "UTILITY AUTOPAY",
          merchant: "City Utilities",
          amount: { minorUnits: "-8250", currency: "USD" },
          accountName: "Primary checking",
          categoryName: "Utilities",
          envelopeName: "Monthly bills",
          status: "removed",
          reviewState: "ready",
          source: "import",
          tags: ["Autopay"],
          isRecurring: true,
          provenance: "Reviewed file import",
          refundLinkIds: [],
        },
      ],
      page: { cursor: null, hasMore: false },
    };

    expect(displayItems(page)[0]).toMatchObject({
      accountId: "account-live",
      envelope: "Monthly bills",
      recurring: true,
      provenance: "Reviewed file import",
      source: "import",
      status: "removed",
      tags: ["Autopay"],
    });
  });

  it("intersects filter groups while allowing alternatives inside each group", () => {
    const item = transaction({ id: "filtered", amountMinorUnits: "-1000", source: "manual" });
    const range = { minimum: "", maximum: "", fromDate: "", toDate: "" };

    expect(
      matchesTransactionFilters(item, {
        query: "corner",
        tab: "all",
        filters: ["Pending", "Posted", "Expense", "Manual"],
        range,
      }),
    ).toBe(true);
    expect(
      matchesTransactionFilters(item, {
        query: "corner",
        tab: "all",
        filters: ["Posted", "Expense", "SimpleFIN"],
        range,
      }),
    ).toBe(false);
  });

  it("requires split parts to equal the parent amount exactly", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    renderWithProviders(
      <SplitTransactionDialog
        open
        item={transaction({ id: "purchase", amountMinorUnits: "-1000" })}
        detail={undefined}
        categories={[category]}
        envelopes={[envelope]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: /split transaction/i });
    const secondAmount = await within(dialog).findByRole("textbox", { name: /split 2 amount/i });
    await user.clear(secondAmount);
    await user.type(secondAmount, "4.99");

    expect(within(dialog).getByText(/\$0\.01 still needs a category/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /save split/i })).toBeDisabled();

    await user.clear(secondAmount);
    await user.type(secondAmount, "5.00");
    await user.click(within(dialog).getByRole("button", { name: /save split/i }));

    expect(onSubmit).toHaveBeenCalledWith([
      { amountMinorUnits: "-500" },
      { amountMinorUnits: "-500" },
    ]);
  });

  it("offers only an exact opposite, same-currency transfer in another account", async () => {
    const user = userEvent.setup();
    const selected = transaction({ id: "outflow", amountMinorUnits: "-30000" });
    const valid = transaction({
      id: "inflow",
      amountMinorUnits: "30000",
      amount: 300,
      merchant: "Savings transfer",
      account: "High-yield savings",
      accountId: "account-savings",
      accountMask: "6118",
    });
    const onSubmit = vi.fn(async () => undefined);
    renderWithProviders(
      <MatchTransferDialog
        open
        item={selected}
        transactions={[
          selected,
          valid,
          transaction({
            id: "wrong-amount",
            amountMinorUnits: "29999",
            account: "Savings",
            accountId: "account-savings",
          }),
          transaction({ id: "same-account", amountMinorUnits: "30000" }),
          transaction({
            id: "wrong-currency",
            amountMinorUnits: "30000",
            currency: "EUR",
            account: "Euro cash",
            accountId: "account-euro",
          }),
        ]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: /match both sides of a transfer/i });
    expect(await within(dialog).findByText(/savings transfer/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/wrong-amount/i)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /confirm transfer match/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      outflowTransactionId: "outflow",
      inflowTransactionId: "inflow",
    });
  });

  it("links a bounded credit to its original purchase", async () => {
    const user = userEvent.setup();
    const purchase = transaction({ id: "purchase", amountMinorUnits: "-5000" });
    const refund = transaction({
      id: "refund",
      amountMinorUnits: "1000",
      amount: 10,
      merchant: "Corner Market refund",
    });
    const onSubmit = vi.fn(async () => undefined);
    renderWithProviders(
      <LinkRefundDialog
        open
        item={purchase}
        transactions={[
          purchase,
          refund,
          transaction({ id: "too-large", amountMinorUnits: "6000", amount: 60 }),
          transaction({
            id: "other-account-credit",
            amountMinorUnits: "1000",
            amount: 10,
            merchant: "Wrong account refund",
            account: "High-yield savings",
            accountId: "account-savings",
          }),
        ]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: /find a refund for this purchase/i });
    expect(await within(dialog).findByText(/corner market refund/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/wrong account refund/i)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: /confirm refund link/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      refundTransactionId: "refund",
      purchaseTransactionId: "purchase",
    });
  });

  it("shows exact transfer evidence and persists confirm or reject review actions", async () => {
    const user = userEvent.setup();
    const selected = transaction({ id: "outflow", amountMinorUnits: "-30000" });
    const counterpart = transaction({
      id: "inflow",
      amountMinorUnits: "30000",
      merchant: "Savings transfer",
      account: "High-yield savings",
    });
    const match = {
      id: "transfer-suggestion",
      outflowTransactionId: selected.id,
      inflowTransactionId: counterpart.id,
      status: "suggested" as const,
      matchedBy: "fingerprint" as const,
    };
    const confirm = vi.fn(async () => undefined);
    const reject = vi.fn(async () => undefined);
    renderWithProviders(
      <TransactionDetail
        open
        item={selected}
        details={transactionDetail(selected, { transfer: match })}
        transactions={[selected, counterpart]}
        detailLoading={false}
        detailError={null}
        categories={[category]}
        onClose={vi.fn()}
        onSave={vi.fn(async () => undefined)}
        onSaveTags={vi.fn(async () => undefined)}
        onRemove={vi.fn(async () => undefined)}
        onRestore={vi.fn(async () => undefined)}
        onAction={vi.fn()}
        onConfirmTransferSuggestion={confirm}
        onRejectTransferSuggestion={reject}
        onConfirmRefundSuggestion={vi.fn(async () => undefined)}
        onRejectRefundSuggestion={vi.fn(async () => undefined)}
        saving={false}
        saveError={null}
      />,
    );

    const review = await screen.findByLabelText(/suggested transfer match/i);
    expect(within(review).getByText(/exact \$300\.00 opposite entry/i)).toBeInTheDocument();
    expect(within(review).getByText(/savings transfer · high-yield savings/i)).toBeInTheDocument();
    await user.click(within(review).getByRole("button", { name: /confirm transfer/i }));
    expect(confirm).toHaveBeenCalledWith(match);
    await user.click(within(review).getByRole("button", { name: /reject match/i }));
    expect(reject).toHaveBeenCalledWith(match.id);
  });

  it("keeps refund suggestions in warning review state until confirm or reject", async () => {
    const user = userEvent.setup();
    const refund = transaction({
      id: "refund",
      amountMinorUnits: "1000",
      merchant: "Corner Market refund",
    });
    const purchase = transaction({ id: "purchase", amountMinorUnits: "-1000" });
    const match = {
      id: "refund-suggestion",
      refundTransactionId: refund.id,
      purchaseTransactionId: purchase.id,
      amount: { minorUnits: "1000", currency: "USD" },
      status: "suggested" as const,
    };
    const confirm = vi.fn(async () => undefined);
    const reject = vi.fn(async () => undefined);
    renderWithProviders(
      <TransactionDetail
        open
        item={refund}
        details={transactionDetail(refund, { refundLinks: [match] })}
        transactions={[refund, purchase]}
        detailLoading={false}
        detailError={null}
        categories={[category]}
        onClose={vi.fn()}
        onSave={vi.fn(async () => undefined)}
        onSaveTags={vi.fn(async () => undefined)}
        onRemove={vi.fn(async () => undefined)}
        onRestore={vi.fn(async () => undefined)}
        onAction={vi.fn()}
        onConfirmTransferSuggestion={vi.fn(async () => undefined)}
        onRejectTransferSuggestion={vi.fn(async () => undefined)}
        onConfirmRefundSuggestion={confirm}
        onRejectRefundSuggestion={reject}
        saving={false}
        saveError={null}
      />,
    );

    const review = await screen.findByLabelText(/suggested refund match/i);
    expect(within(review).getByText(/link \$10\.00 to the original purchase/i)).toBeInTheDocument();
    expect(within(review).getByText(/exact opposite amount/i)).toBeInTheDocument();
    await user.click(within(review).getByRole("button", { name: /confirm refund/i }));
    expect(confirm).toHaveBeenCalledWith(match);
    await user.click(within(review).getByRole("button", { name: /reject match/i }));
    expect(reject).toHaveBeenCalledWith(match.id);
  });

  it("adds accessible tags with Enter and persists them with the transaction", async () => {
    const user = userEvent.setup();
    const item = transaction({
      id: "tagged-purchase",
      amountMinorUnits: "-1000",
      tags: ["Tax Deductible"],
    });
    const saveTags = vi.fn(async () => undefined);
    renderWithProviders(
      <TransactionDetail
        open
        item={item}
        details={transactionDetail(item, { tags: item.tags })}
        transactions={[item]}
        detailLoading={false}
        detailError={null}
        categories={[category]}
        onClose={vi.fn()}
        onSave={vi.fn(async () => undefined)}
        onSaveTags={saveTags}
        onRemove={vi.fn(async () => undefined)}
        onRestore={vi.fn(async () => undefined)}
        onAction={vi.fn()}
        onConfirmTransferSuggestion={vi.fn(async () => undefined)}
        onRejectTransferSuggestion={vi.fn(async () => undefined)}
        onConfirmRefundSuggestion={vi.fn(async () => undefined)}
        onRejectRefundSuggestion={vi.fn(async () => undefined)}
        saving={false}
        saveError={null}
      />,
    );

    const input = screen.getByRole("textbox", { name: /add transaction tag/i });
    await user.type(input, "Side Hustle{Enter}");
    expect(screen.getByText("Side Hustle")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(saveTags).toHaveBeenCalledWith(item, ["Tax Deductible", "Side Hustle"]);
  });

  it("uses reversible removal and exposes restore for retained ledger history", async () => {
    const user = userEvent.setup();
    const item = transaction({ id: "remove-me", amountMinorUnits: "-1000" });
    const remove = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);
    const { unmount } = renderWithProviders(
      <TransactionDetail
        open
        item={item}
        details={transactionDetail(item)}
        transactions={[item]}
        detailLoading={false}
        detailError={null}
        categories={[category]}
        onClose={vi.fn()}
        onSave={vi.fn(async () => undefined)}
        onSaveTags={vi.fn(async () => undefined)}
        onRemove={remove}
        onRestore={restore}
        onAction={vi.fn()}
        onConfirmTransferSuggestion={vi.fn(async () => undefined)}
        onRejectTransferSuggestion={vi.fn(async () => undefined)}
        onConfirmRefundSuggestion={vi.fn(async () => undefined)}
        onRejectRefundSuggestion={vi.fn(async () => undefined)}
        saving={false}
        saveError={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: /remove transaction/i }));
    const confirmation = screen.getByRole("dialog", { name: /remove corner market/i });
    expect(confirmation).toHaveTextContent(/without deleting imported history/i);
    await user.click(within(confirmation).getByRole("button", { name: /confirm removal/i }));
    expect(remove).toHaveBeenCalledWith(item);

    unmount();
    const removed = transaction({
      id: item.id,
      amountMinorUnits: item.amountMinorUnits,
      status: "removed",
    });
    renderWithProviders(
      <TransactionDetail
        open
        item={removed}
        details={transactionDetail(removed)}
        transactions={[removed]}
        detailLoading={false}
        detailError={null}
        categories={[category]}
        onClose={vi.fn()}
        onSave={vi.fn(async () => undefined)}
        onSaveTags={vi.fn(async () => undefined)}
        onRemove={remove}
        onRestore={restore}
        onAction={vi.fn()}
        onConfirmTransferSuggestion={vi.fn(async () => undefined)}
        onRejectTransferSuggestion={vi.fn(async () => undefined)}
        onConfirmRefundSuggestion={vi.fn(async () => undefined)}
        onRejectRefundSuggestion={vi.fn(async () => undefined)}
        saving={false}
        saveError={null}
      />,
    );

    expect(screen.queryByRole("textbox", { name: /merchant/i })).toBeNull();
    await user.click(screen.getByRole("button", { name: /restore transaction/i }));
    expect(restore).toHaveBeenCalledWith(removed);
  });

  it("previews a narrow exact rule before allowing creation", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn(async () => ({
      matchCount: 3,
      aggregateAmount: { minorUnits: "-3000", currency: "USD" },
      samples: [],
      conflicts: [],
    }));
    const onSubmit = vi.fn(async () => undefined);
    renderWithProviders(
      <CreateTransactionRuleDialog
        open
        item={transaction({ id: "purchase", amountMinorUnits: "-1000" })}
        detail={undefined}
        categories={[category]}
        onClose={vi.fn()}
        onPreview={onPreview}
        onSubmit={onSubmit}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: /create a transaction rule/i });
    const createButton = within(dialog).getByRole("button", { name: /confirm and create rule/i });
    expect(createButton).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: /run preview/i }));

    expect(onPreview).toHaveBeenCalledWith({
      conditions: {
        field: "normalizedDescription",
        operator: "exact",
        value: "CORNER MARKET #104",
        caseSensitive: false,
      },
      actions: [{ type: "setCategory", categoryId: category.id }],
    });
    expect(await within(dialog).findByText(/3 historical matches/i)).toBeInTheDocument();
    await user.click(createButton);

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Corner Market → Groceries",
        enabled: true,
        origin: "user",
      }),
    );
  });

  it("creates an exact signed manual ledger entry", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    renderWithProviders(
      <ManualTransactionDialog
        open
        accounts={[account]}
        categories={[category]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: /add a transaction/i });
    await user.type(within(dialog).getByRole("textbox", { name: /^amount/i }), "12.34");
    await user.type(within(dialog).getByRole("textbox", { name: /description/i }), "Cash lunch");
    await user.click(within(dialog).getByRole("button", { name: /^add transaction$/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: account.id,
        amountMinorUnits: "-1234",
        currency: "USD",
        description: "Cash lunch",
      }),
    );
  });

  it("shows an import result after the reviewed local file is committed", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => ({
      id: "import-1",
      state: "succeeded" as const,
      totalRecords: 1,
      importedRecords: 1,
      duplicateRecords: 0,
      rejectedRecords: 0,
    }));
    renderWithProviders(
      <ImportTransactionsDialog open accounts={[account]} onClose={vi.fn()} onSubmit={onSubmit} />,
    );

    const dialog = screen.getByRole("dialog", { name: /import transactions/i });
    const file = new File(["date,description,amount\n2026-07-16,Coffee,-4.25\n"], "checking.csv", {
      type: "text/csv",
    });
    if (!("text" in file)) {
      Object.defineProperty(file, "text", {
        value: async () => "date,description,amount\n2026-07-16,Coffee,-4.25\n",
      });
    }
    await user.upload(within(dialog).getByLabelText(/transaction import file/i), file);
    expect(await within(dialog).findByText(/1 estimated transaction row/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /import 1/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: account.id,
        filename: "checking.csv",
        currency: "USD",
      }),
    );
    expect(await within(dialog).findByText(/1 imported/i)).toBeInTheDocument();
  });
});
