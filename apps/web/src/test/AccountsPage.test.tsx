import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, waitForElementToBeRemoved, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ApiAccount, api } from "../api";
import { AppProviders } from "../contexts";
import { AccountsPage, parseSignedCurrencyMinorUnits } from "../pages/AccountsPage";

function renderPage(path = "/accounts") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppProviders>
        <MemoryRouter initialEntries={[path]}>
          <AccountsPage />
        </MemoryRouter>
      </AppProviders>
    </QueryClientProvider>,
  );
}

function liveAccount(input: Partial<ApiAccount> & Pick<ApiAccount, "id" | "name">): ApiAccount {
  const { id, name, ...overrides } = input;
  return {
    id,
    name,
    mask: "1234",
    group: "cash",
    type: "checking",
    subtype: null,
    institutionName: "Truth Bank",
    isManual: false,
    includeInBudget: true,
    includeInNetWorth: true,
    status: "active",
    balance: { minorUnits: "100000", currency: "USD" },
    syncStatus: "healthy",
    updatedAt: "2026-07-17T12:00:00.000Z",
    ...overrides,
  };
}

function mockLiveAccountQueries(accountData: ApiAccount[]) {
  vi.spyOn(api, "accounts").mockResolvedValue({
    data: accountData,
    page: { cursor: null, hasMore: false },
  });
  vi.spyOn(api, "assets").mockResolvedValue({
    data: [],
    page: { cursor: null, hasMore: false },
  });
  vi.spyOn(api, "connections").mockResolvedValue({
    data: [],
    page: { cursor: null, hasMore: false },
  });
  vi.spyOn(api, "accountBalances").mockImplementation(async (id) => {
    const account = accountData.find((item) => item.id === id)!;
    return {
      account: { id, name: account.name, currency: "USD" },
      data: [],
      summary: {
        current: account.balance,
        change: { minorUnits: "0", currency: "USD" },
        latestAsOf: account.updatedAt,
        reconciled: null,
      },
    };
  });
}

describe("Accounts", () => {
  beforeEach(() => {
    window.sessionStorage.setItem("bw-demo", "true");
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

  it("parses signed manual balances without floating-point math", () => {
    expect(parseSignedCurrencyMinorUnits("$12,345.67")).toBe("1234567");
    expect(parseSignedCurrencyMinorUnits("-12000.05")).toBe("-1200005");
    expect(parseSignedCurrencyMinorUnits("1.009")).toBeNull();
    expect(parseSignedCurrencyMinorUnits("not money")).toBeNull();
  });

  it("shows connected accounts and dated balance truth", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(
      screen.getByRole("heading", { level: 1, name: /every balance, in its proper place/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /everyday checking/i }));

    const drawer = screen.getByRole("presentation");
    expect(within(drawer).getByRole("heading", { name: "Everyday checking" })).toBeInTheDocument();
    expect(within(drawer).getByText(/6 dated balance snapshots/i)).toBeInTheDocument();
    expect(within(drawer).queryByText(/reconciliation|ledger balances agree/i)).toBeNull();
    expect(within(drawer).getByRole("combobox", { name: /account group/i })).toBeVisible();
    expect(within(drawer).getByRole("textbox", { name: /^account type$/i })).toHaveValue(
      "Checking",
    );
    expect(within(drawer).getByRole("combobox", { name: /account status/i })).toBeVisible();
    expect(within(drawer).getByRole("tab", { name: /transactions/i })).toBeInTheDocument();
  });

  it("opens the quick-add workflow from the URL action", async () => {
    const user = userEvent.setup();
    renderPage("/accounts?action=add");

    const chooser = await screen.findByRole("dialog", { name: /add to betterwealth/i });
    await user.click(within(chooser).getByRole("button", { name: /manual account/i }));

    const form = screen.getByRole("dialog", { name: /add manual account/i });
    expect(within(form).getByRole("textbox", { name: /^name$/i })).toBeInTheDocument();
    expect(within(form).getByRole("combobox", { name: /account group/i })).toBeInTheDocument();
    expect(within(form).getByRole("textbox", { name: /opening balance/i })).toBeInTheDocument();
  });

  it("starts a manual asset with a valid asset type and non-negative value", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /^add$/i }));
    await user.click(screen.getByRole("button", { name: /manual asset/i }));
    const form = screen.getByRole("dialog", { name: /add manual asset/i });
    expect(within(form).getByRole("combobox", { name: /asset type/i })).toHaveTextContent(
      "Property",
    );
    const value = within(form).getByRole("textbox", { name: /current value/i });
    await user.clear(value);
    await user.type(value, "-1");
    expect(within(form).getByRole("button", { name: /^add$/i })).toBeDisabled();
  });

  it("adds a manual account to the interactive demo instead of closing as a no-op", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /^add$/i }));
    await user.click(screen.getByRole("button", { name: /manual account/i }));
    const form = screen.getByRole("dialog", { name: /add manual account/i });
    await user.type(within(form).getByRole("textbox", { name: /^name$/i }), "Side hustle cash");
    const balance = within(form).getByRole("textbox", { name: /opening balance/i });
    await user.clear(balance);
    await user.type(balance, "425.50");
    await user.click(within(form).getByRole("button", { name: /^add$/i }));
    await waitForElementToBeRemoved(form);

    expect(
      screen.getByText(/side hustle cash was added to this interactive demo session/i),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /side hustle cash/i })).toBeVisible();
  });

  it("lets a manual debt append a signed balance snapshot", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /student loan/i }));
    const drawer = screen.getByRole("presentation");
    const balance = within(drawer).getByRole("textbox", { name: /recorded balance/i });
    expect(balance).toHaveValue("-12000.00");
    await user.clear(balance);
    await user.type(balance, "-11,750.25");
    const save = within(drawer).getByRole("button", { name: /save changes/i });
    expect(save).toBeEnabled();
    await user.click(save);
    expect(
      screen.getByText(/student loan was updated for this interactive demo session/i),
    ).toBeVisible();
  });

  it("routes connection setup to the live integrations settings", () => {
    renderPage();

    expect(screen.getByRole("link", { name: /connect institution/i })).toHaveAttribute(
      "href",
      "/settings?section=integrations",
    );
  });

  it("requests account-scoped recent activity instead of filtering the global first page", async () => {
    window.sessionStorage.setItem("bw-demo", "false");
    const account = liveAccount({ id: "01JACCOUNT00000000000000001", name: "Quiet checking" });
    mockLiveAccountQueries([account]);
    const accountTransactions = vi.spyOn(api, "accountTransactions").mockResolvedValue({
      data: [
        {
          id: "old-scoped-entry",
          accountId: account.id,
          effectiveDate: "2024-01-01T00:00:00.000Z",
          description: "Old scoped entry",
          merchant: "Old scoped entry",
          amount: { minorUnits: "-321", currency: "USD" },
          accountName: account.name,
          categoryName: "Other",
          status: "posted",
          reviewState: "ready",
          source: "simplefin",
          tags: [],
        },
      ],
      page: { cursor: "older-page", hasMore: true },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /quiet checking/i }));
    const drawer = screen.getByRole("presentation");
    await user.click(within(drawer).getByRole("tab", { name: /transactions/i }));

    await waitFor(() => expect(accountTransactions).toHaveBeenCalledWith(account.id, 100));
    expect(within(drawer).getByText("Old scoped entry")).toBeVisible();
    expect(
      within(drawer).getByText(/100 most recent ledger entries for this account/i),
    ).toBeVisible();
  });

  it("keeps hidden and closed accounts recoverable but out of active totals", async () => {
    window.sessionStorage.setItem("bw-demo", "false");
    const accountData = [
      liveAccount({ id: "01JACCOUNT00000000000000002", name: "Active checking" }),
      liveAccount({
        id: "01JACCOUNT00000000000000003",
        name: "Hidden vault",
        status: "hidden",
        balance: { minorUnits: "900000", currency: "USD" },
      }),
      liveAccount({
        id: "01JACCOUNT00000000000000004",
        name: "Closed checking",
        status: "closed",
        balance: { minorUnits: "700000", currency: "USD" },
      }),
    ];
    mockLiveAccountQueries(accountData);
    const updateAccount = vi
      .spyOn(api, "updateAccount")
      .mockResolvedValue({ id: accountData[1]!.id, updated: true });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("1 active account + 0 assets")).toBeVisible();
    expect(screen.getByText(/^1 account$/)).toBeVisible();
    expect(screen.getByText("Hidden & closed accounts")).toBeVisible();
    expect(
      screen.getByText(/excluded from active totals, net worth, budgets, and safe to spend/i),
    ).toBeVisible();
    expect(screen.getByText("Hidden vault")).toBeVisible();
    expect(screen.getByText("Closed checking")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Reopen Hidden vault" }));
    await waitFor(() =>
      expect(updateAccount).toHaveBeenCalledWith(accountData[1]!.id, { status: "active" }),
    );
  });
});
