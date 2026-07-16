import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../contexts";
import { dollarsToMinor, NetWorthPage } from "../pages/WealthPages";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppProviders>
        <NetWorthPage />
      </AppProviders>
    </QueryClientProvider>,
  );
}

describe("Net Worth assets", () => {
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

  it("parses asset dollars exactly without floating-point rounding", () => {
    expect(dollarsToMinor("1,234.56")).toBe("123456");
    expect(dollarsToMinor("0")).toBe("0");
    expect(dollarsToMinor("0.009")).toBeNull();
    expect(dollarsToMinor("1e3")).toBeNull();
    expect(dollarsToMinor("-1")).toBeNull();
  });

  it("shows live-shaped valued assets and all available wealth metrics", async () => {
    renderPage();

    expect(
      screen.getByRole("heading", { level: 1, name: /net worth, without the blur/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2019 Honda Civic" })).toBeInTheDocument();
    for (const metric of ["Total", "Liquid", "Investable", "Retirement", "Assets", "Debts"]) {
      expect(
        screen.getByText(metric, { selector: ".MuiChip-label" }).closest("button, .MuiChip-root"),
      ).not.toHaveAttribute("aria-disabled", "true");
    }
  });

  it("opens the dated valuation workflow with prior history", async () => {
    const user = userEvent.setup();
    renderPage();

    const card = screen.getByRole("heading", { name: "2019 Honda Civic" }).closest(".MuiCard-root");
    expect(card).not.toBeNull();
    await user.click(within(card as HTMLElement).getByRole("button", { name: /update value/i }));

    const dialog = screen.getByRole("dialog", { name: /record a new valuation/i });
    expect(within(dialog).getByRole("combobox", { name: /asset/i })).toHaveTextContent(
      "2019 Honda Civic",
    );
    expect(within(dialog).getByText(/valuation history/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/7\/1\/2026/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("textbox", { name: /source link or note/i }),
    ).toBeInTheDocument();

    const amount = within(dialog).getByRole("textbox", { name: /estimated value/i });
    const save = within(dialog).getByRole("button", { name: /record valuation/i });
    await user.clear(amount);
    await user.type(amount, "0.009");
    expect(save).toBeDisabled();
    expect(within(dialog).getByText(/no more than 2 decimals/i)).toBeInTheDocument();
    await user.clear(amount);
    await user.type(amount, "0");
    expect(save).toBeEnabled();
  });

  it("opens a complete create-asset form", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /^add asset$/i }));
    const dialog = screen.getByRole("dialog", { name: /add a valued asset/i });
    expect(within(dialog).getByRole("textbox", { name: /asset name/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: /current value/i })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/valuation date/i)).toBeInTheDocument();
    const save = within(dialog).getByRole("button", { name: /^add asset$/i });
    expect(save).toBeDisabled();

    await user.type(within(dialog).getByRole("textbox", { name: /asset name/i }), "Tiny house");
    const value = within(dialog).getByRole("textbox", { name: /current value/i });
    await user.type(value, "1.999");
    expect(save).toBeDisabled();
    await user.clear(value);
    await user.type(value, "1,234.56");
    expect(save).toBeEnabled();
  });
});
