import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "../contexts";
import { GoalsPage } from "../pages/WealthPages";

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{`${location.pathname}${location.search}`}</output>;
}

function renderPage(path = "/goals") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppProviders>
        <MemoryRouter initialEntries={[path]}>
          <GoalsPage />
          <LocationProbe />
        </MemoryRouter>
      </AppProviders>
    </QueryClientProvider>,
  );
}

describe("Goals planning", () => {
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

  it("shows data-derived funding pace without a fabricated probability", () => {
    renderPage();

    expect(
      screen.getByRole("heading", { level: 1, name: /turn surplus into options/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/emergency fund is first in your funding order/i)).toBeInTheDocument();
    expect(screen.getAllByText("On pace").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pace needed").length).toBeGreaterThan(0);
    expect(screen.queryByText(/% likely/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/age-30 impact/i)).not.toBeInTheDocument();
  });

  it("opens a complete goal editor from the quick-action query parameter and clears it", async () => {
    renderPage("/goals?action=add");

    const dialog = await screen.findByRole("dialog", { name: /create a goal/i });
    expect(within(dialog).getByRole("textbox", { name: /goal name/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: /target amount/i })).toBeInTheDocument();
    expect(
      within(dialog).getByRole("textbox", { name: /monthly contribution/i }),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/target date/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: /funding account/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /create goal/i })).toBeDisabled();
    expect(screen.getByLabelText("location")).toHaveTextContent("/goals");
  });

  it("recalculates the date in the what-if planner from editable inputs", async () => {
    const user = userEvent.setup();
    renderPage();

    const card = screen.getByRole("heading", { name: /\$100k invested/i }).closest(".MuiCard-root");
    expect(card).not.toBeNull();
    await user.click(within(card as HTMLElement).getByRole("button", { name: /what if/i }));

    const dialog = screen.getByRole("dialog", { name: /\$100k invested: test the plan/i });
    expect(within(dialog).getByText(/2036/i)).toBeInTheDocument();
    const monthly = within(dialog).getByRole("textbox", { name: /what-if monthly pace/i });
    await user.clear(monthly);
    await user.type(monthly, "1500");
    expect(within(dialog).getByText(/2031/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/month.*sooner/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/This view models goal funding only/i)).toBeInTheDocument();
  });

  it("makes funding semantics explicit and enforces the remaining balance", async () => {
    const user = userEvent.setup();
    renderPage();

    const card = screen.getByRole("heading", { name: /emergency fund/i }).closest(".MuiCard-root");
    expect(card).not.toBeNull();
    await user.click(within(card as HTMLElement).getByRole("button", { name: /^fund$/i }));

    const dialog = screen.getByRole("dialog", { name: /fund emergency fund/i });
    expect(within(dialog).getByText(/does not initiate a bank transfer/i)).toBeInTheDocument();
    const amount = within(dialog).getByRole("textbox", { name: /contribution/i });
    await user.clear(amount);
    await user.type(amount, "7500.01");
    expect(within(dialog).getByRole("button", { name: /record contribution/i })).toBeDisabled();
  });
});
