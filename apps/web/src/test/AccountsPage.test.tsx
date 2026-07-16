import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(within(drawer).getByText(/current and ledger balances agree/i)).toBeInTheDocument();
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

  it("lets a manual debt append a signed balance snapshot", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /student loan/i }));
    const drawer = screen.getByRole("presentation");
    const balance = within(drawer).getByRole("textbox", { name: /recorded balance/i });
    expect(balance).toHaveValue("-12000.00");
    await user.clear(balance);
    await user.type(balance, "-11,750.25");
    expect(within(drawer).getByRole("button", { name: /save changes/i })).toBeEnabled();
  });

  it("routes connection setup to the live integrations settings", () => {
    renderPage();

    expect(screen.getByRole("link", { name: /connect institution/i })).toHaveAttribute(
      "href",
      "/settings?section=integrations",
    );
  });
});
