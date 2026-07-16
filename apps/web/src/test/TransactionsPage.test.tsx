import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiAccount, ApiCategory, ApiEnvelope } from "../api";
import { AppProviders } from "../contexts";
import {
  CreateTransactionRuleDialog,
  ImportTransactionsDialog,
  LinkRefundDialog,
  ManualTransactionDialog,
  MatchTransferDialog,
  parsePositiveCurrencyMinorUnits,
  SplitTransactionDialog,
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
    isTransfer: false,
    isIncome: false,
    hasSplits: false,
    refundLinkIds: [],
    provenance: "SimpleFIN import",
    ...overrides,
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
          transaction({ id: "wrong-amount", amountMinorUnits: "29999", account: "Savings" }),
          transaction({ id: "same-account", amountMinorUnits: "30000" }),
          transaction({
            id: "wrong-currency",
            amountMinorUnits: "30000",
            currency: "EUR",
            account: "Euro cash",
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
        ]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: /find a refund for this purchase/i });
    expect(await within(dialog).findByText(/corner market refund/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /confirm refund link/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      refundTransactionId: "refund",
      purchaseTransactionId: "purchase",
    });
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

    const dialog = screen.getByRole("dialog", { name: /create a narrow transaction rule/i });
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
