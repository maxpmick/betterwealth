import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComfortablePurchasePlan } from "../api";
import { AppProviders } from "../contexts";
import { ComfortablePurchaseSummary, GoalsPage } from "../pages/WealthPages";

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
    window.localStorage.removeItem("bw-privacy");
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

    expect(screen.getByRole("heading", { level: 1, name: /^goals$/i })).toBeInTheDocument();
    expect(screen.getByText(/emergency fund is first in your funding order/i)).toBeInTheDocument();
    expect(screen.getAllByText("On pace").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pace needed").length).toBeGreaterThan(0);
    expect(screen.queryByText(/% likely/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/age-30 impact/i)).not.toBeInTheDocument();
    const purchaseCard = screen
      .getByRole("heading", { name: /lisbon trip/i })
      .closest(".MuiCard-root");
    expect(purchaseCard).not.toBeNull();
    expect(
      within(purchaseCard as HTMLElement).getByText(/modeled guardrails clear in april 2027/i),
    ).toBeInTheDocument();
    expect(
      within(purchaseCard as HTMLElement).getByText(/wealth target preserved:/i),
    ).toBeInTheDocument();
    expect(
      within(purchaseCard as HTMLElement).getByText(/projected liquid net worth/i),
    ).toBeInTheDocument();
    expect(
      within(purchaseCard as HTMLElement).getByText(/funding projection: january 2027/i),
    ).toBeInTheDocument();
  });

  it("fails closed in the UI when comfortable-purchase inputs are missing", () => {
    const plan: ComfortablePurchasePlan = {
      status: "incomplete",
      comfortable: null,
      comfortableMonth: null,
      monthsUntilPurchase: null,
      controllingConstraint: "incompleteInputs",
      limitingConstraints: [
        {
          code: "incompleteInputs",
          label: "Planning inputs incomplete",
          satisfied: null,
          detail: "Confirm a protected minimum cash buffer",
        },
      ],
      constraints: [],
      missingInputs: ["Confirm a protected minimum cash buffer", "Confirm a liquid wealth target"],
      inputs: {
        spendableLiquidity: null,
        unreservedLiquidity: null,
        fundingAccountBalance: null,
        verifiedPurchaseSavings: null,
        protectedMinimumBuffer: null,
        requiredMonthlyBills: null,
        requiredObligationShortfall: null,
        higherPriorityMonthlyFunding: { minorUnits: "0", currency: "USD" },
        monthlySurplus: null,
        monthlySurplusSource: null,
        currentLiquidNetWorth: null,
        targetLiquidNetWorth: null,
        targetWealthDate: null,
        projectedLiquidNetWorthAtTarget: null,
      },
      assumptions: ["No date without complete inputs"],
    };
    render(
      <AppProviders>
        <ComfortablePurchaseSummary plan={plan} fundingProjectedLabel="January 2027" />
      </AppProviders>,
    );

    expect(screen.getByText(/not enough data to estimate a comfortable date/i)).toBeInTheDocument();
    expect(screen.getByText(/confirm a protected minimum cash buffer/i)).toBeInTheDocument();
    expect(screen.getByText(/confirm a liquid wealth target/i)).toBeInTheDocument();
    expect(screen.queryByText(/^guardrails clear$/i)).not.toBeInTheDocument();
  });

  it("presents a current-month result as now without inventing a past first-of-month date", () => {
    const plan: ComfortablePurchasePlan = {
      status: "comfortable",
      comfortable: true,
      comfortableMonth: new Date().toISOString().slice(0, 7),
      monthsUntilPurchase: 0,
      controllingConstraint: "purchaseFunding",
      limitingConstraints: [],
      constraints: [],
      missingInputs: [],
      inputs: {
        spendableLiquidity: { minorUnits: "500000", currency: "USD" },
        unreservedLiquidity: { minorUnits: "300000", currency: "USD" },
        fundingAccountBalance: { minorUnits: "500000", currency: "USD" },
        verifiedPurchaseSavings: { minorUnits: "100000", currency: "USD" },
        protectedMinimumBuffer: { minorUnits: "200000", currency: "USD" },
        requiredMonthlyBills: { minorUnits: "100000", currency: "USD" },
        requiredObligationShortfall: { minorUnits: "0", currency: "USD" },
        higherPriorityMonthlyFunding: { minorUnits: "0", currency: "USD" },
        monthlySurplus: { minorUnits: "100000", currency: "USD" },
        monthlySurplusSource: "explicit_budget",
        currentLiquidNetWorth: { minorUnits: "400000", currency: "USD" },
        targetLiquidNetWorth: { minorUnits: "50000000", currency: "USD" },
        targetWealthDate: "2034-07-01",
        projectedLiquidNetWorthAtTarget: { minorUnits: "50000000", currency: "USD" },
      },
      assumptions: ["Capped transfers stop at target."],
    };
    render(
      <AppProviders>
        <ComfortablePurchaseSummary plan={plan} fundingProjectedLabel="already fully funded" />
      </AppProviders>,
    );

    expect(screen.getByText(/modeled guardrails clear now/i)).toBeInTheDocument();
    expect(screen.queryByText(/comfortable to buy/i)).not.toBeInTheDocument();
    expect(screen.getByText(/capped transfers stop at target/i)).toBeInTheDocument();
  });

  it("explains an impossible wealth-target guardrail in plain language", () => {
    const plan: ComfortablePurchasePlan = {
      status: "not_comfortable",
      comfortable: false,
      comfortableMonth: null,
      monthsUntilPurchase: null,
      controllingConstraint: "horizon",
      limitingConstraints: [
        {
          code: "targetNetWorth",
          label: "Wealth target preserved",
          satisfied: false,
          detail:
            "Projected liquid net worth must meet the saved age-30 target after a conservative full purchase-price write-off.",
        },
        {
          code: "horizon",
          label: "Planning horizon",
          satisfied: false,
          detail: "No month clears every guardrail.",
        },
      ],
      constraints: [],
      missingInputs: [],
      inputs: {
        spendableLiquidity: { minorUnits: "500000", currency: "USD" },
        unreservedLiquidity: { minorUnits: "300000", currency: "USD" },
        fundingAccountBalance: { minorUnits: "500000", currency: "USD" },
        verifiedPurchaseSavings: { minorUnits: "100000", currency: "USD" },
        protectedMinimumBuffer: { minorUnits: "200000", currency: "USD" },
        requiredMonthlyBills: { minorUnits: "100000", currency: "USD" },
        requiredObligationShortfall: { minorUnits: "0", currency: "USD" },
        higherPriorityMonthlyFunding: { minorUnits: "50000", currency: "USD" },
        monthlySurplus: { minorUnits: "100000", currency: "USD" },
        monthlySurplusSource: "explicit_budget",
        currentLiquidNetWorth: { minorUnits: "400000", currency: "USD" },
        targetLiquidNetWorth: { minorUnits: "50000000", currency: "USD" },
        targetWealthDate: "2034-07-01",
        projectedLiquidNetWorthAtTarget: { minorUnits: "12400000", currency: "USD" },
      },
      assumptions: ["Full write-off"],
    };
    render(
      <AppProviders>
        <ComfortablePurchaseSummary plan={plan} fundingProjectedLabel="Already fully funded" />
      </AppProviders>,
    );

    expect(screen.getByText(/no comfortable date in the 10-year window/i)).toBeInTheDocument();
    expect(screen.getByText(/wealth target preserved:/i)).toBeInTheDocument();
    expect(screen.getByText(/projected liquid net worth/i)).toBeInTheDocument();
    expect(screen.getByText(/planning horizon:/i)).toBeInTheDocument();
    expect(screen.getByText(/no month clears every guardrail/i)).toBeInTheDocument();
    const wealthTarget = screen.getByText("Liquid wealth target").parentElement;
    expect(wealthTarget).not.toBeNull();
    expect(within(wealthTarget as HTMLElement).getByText("$500,000")).toBeInTheDocument();
    expect(wealthTarget).toHaveTextContent(/by july 2034/i);
    expect(screen.queryByText(/jul 1, 2034/i)).not.toBeInTheDocument();
    expect(screen.getByText(/projected liquid wealth at target month/i)).toBeInTheDocument();
    expect(screen.getByText("$124,000")).toBeInTheDocument();
    expect(screen.getByText(/current budget/i)).toBeInTheDocument();
    expect(screen.getByText(/full write-off/i)).toBeInTheDocument();
  });

  it("hides every modeled purchase amount while retaining source and month context", () => {
    window.localStorage.setItem("bw-privacy", "true");
    const plan: ComfortablePurchasePlan = {
      status: "not_comfortable",
      comfortable: false,
      comfortableMonth: null,
      monthsUntilPurchase: null,
      controllingConstraint: "requiredObligations",
      limitingConstraints: [
        {
          code: "requiredObligations",
          label: "Required obligations covered",
          satisfied: false,
          detail:
            "One or more required bill maximums are not fully represented in the current budget.",
        },
      ],
      constraints: [],
      missingInputs: [],
      inputs: {
        spendableLiquidity: { minorUnits: "500000", currency: "USD" },
        unreservedLiquidity: { minorUnits: "300000", currency: "USD" },
        fundingAccountBalance: { minorUnits: "500000", currency: "USD" },
        verifiedPurchaseSavings: { minorUnits: "100000", currency: "USD" },
        protectedMinimumBuffer: { minorUnits: "200000", currency: "USD" },
        requiredMonthlyBills: { minorUnits: "110000", currency: "USD" },
        requiredObligationShortfall: { minorUnits: "0", currency: "USD" },
        higherPriorityMonthlyFunding: { minorUnits: "50000", currency: "USD" },
        monthlySurplus: { minorUnits: "125000", currency: "USD" },
        monthlySurplusSource: "explicit_budget",
        currentLiquidNetWorth: { minorUnits: "400000", currency: "USD" },
        targetLiquidNetWorth: { minorUnits: "50000000", currency: "USD" },
        targetWealthDate: "2034-07-01",
        projectedLiquidNetWorthAtTarget: { minorUnits: "12400000", currency: "USD" },
      },
      assumptions: ["Capped transfers stop at target."],
    };
    const { container } = render(
      <AppProviders>
        <ComfortablePurchaseSummary plan={plan} fundingProjectedLabel="April 2027" />
      </AppProviders>,
    );

    expect(screen.getAllByLabelText("Amount hidden")).toHaveLength(7);
    expect(container.textContent).not.toMatch(/\$\s*\d/);
    expect(screen.getByText(/· current budget/i)).toBeInTheDocument();
    expect(screen.getByText(/by july 2034/i)).toBeInTheDocument();
    expect(
      screen.getByText(/required bill maximums are not fully represented/i),
    ).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/minor units/i);
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

    const dialog = screen.getByRole("dialog", { name: /what if: \$100k invested/i });
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
    expect(within(dialog).getByText(/does not move money between accounts/i)).toBeInTheDocument();
    const amount = within(dialog).getByRole("textbox", { name: /contribution/i });
    await user.clear(amount);
    await user.type(amount, "7500.01");
    expect(within(dialog).getByRole("button", { name: /record contribution/i })).toBeDisabled();
  });
});
