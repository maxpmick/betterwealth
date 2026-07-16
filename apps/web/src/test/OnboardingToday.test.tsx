import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiGoal, ApiGoalContribution, DashboardReport } from "../api";
import { AppProviders } from "../contexts";
import { OnboardingPage } from "../pages/OnboardingPage";
import { deriveWeeklyGoalAction, TodayPage } from "../pages/TodayPage";

function installMatchMedia() {
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
}

function renderPage(page: React.ReactNode, path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppProviders>
        <MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>
      </AppProviders>
    </QueryClientProvider>,
  );
}

const readyDashboard: DashboardReport = {
  safeToSpend: { minorUnits: "285025", currency: "USD" },
  safePerDay: { minorUnits: "20358", currency: "USD" },
  coveredThrough: "2026-07-30T23:59:59.999Z",
  coveredThroughSource: "income_source",
  availableCash: { minorUnits: "385025", currency: "USD" },
  reservedBills: { minorUnits: "0", currency: "USD" },
  envelopeCommitments: { minorUnits: "0", currency: "USD" },
  goalContributions: { minorUnits: "0", currency: "USD" },
  minimumBuffer: { minorUnits: "100000", currency: "USD" },
  projectedLiquidNetWorth: { minorUnits: "385025", currency: "USD" },
  targetLiquidNetWorth: { minorUnits: "25000000", currency: "USD" },
  targetAge: 30,
  projectionSource: "current_balance",
  savingsRate: 0,
  trust: {
    state: "incomplete",
    asOf: "2026-07-16T12:00:00.000Z",
    pendingImpact: { minorUnits: "0", currency: "USD" },
    missingInputs: ["Create or fund an envelope budget for this pay period"],
    confidenceLabel: "Setup in progress",
  },
};

describe("new-user onboarding", () => {
  beforeEach(installMatchMedia);

  it("keeps the fictional demo read-only and skips every API mutation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage(<OnboardingPage />, "/onboarding");

    await user.click(screen.getByRole("button", { name: /explore demo data/i }));
    await user.click(screen.getByRole("button", { name: /open demo plan/i }));

    expect(
      screen.getByRole("heading", { level: 1, name: /your first plan is ready/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/alex’s fictional, fully reconciled fixture/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves exact manual, profile, target, paycheck, buffer, and zero-bill inputs", async () => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ path, method, body });
      let response: unknown = {};
      let status = 200;
      if (path === "/api/v1/accounts" && method === "POST") {
        response = { id: "manual-account" };
        status = 201;
      } else if (path === "/api/v1/income-sources" && method === "POST") {
        response = { id: "income-1", ...body };
        status = 201;
      } else if (path === "/api/v1/profile" && method === "PATCH") {
        response = { updated: true };
      } else if (path === "/api/v1/reports/dashboard/preferences" && method === "PATCH") {
        response = {
          currency: "USD",
          minimumBuffer: null,
          targetLiquidNetWorth: null,
          reservedBills: null,
          ...body,
        };
      } else if (path === "/api/v1/reports/dashboard") {
        response = readyDashboard;
      } else {
        return new Response(
          JSON.stringify({ error: { message: `Unexpected ${method} ${path}` } }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify(response), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage(<OnboardingPage />, "/onboarding");

    await user.click(screen.getByRole("button", { name: /start manually/i }));
    await user.type(screen.getByRole("textbox", { name: /opening balance/i }), "3850.25");
    await user.click(screen.getByRole("button", { name: /^continue$/i }));

    expect(
      screen.getByRole("heading", { level: 1, name: /define your age-30 horizon/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^continue$/i }));

    expect(
      await screen.findByRole("heading", { level: 1, name: /give the next paycheck a job/i }),
    ).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /net pay per paycheck/i }), "2200");
    await user.type(screen.getByRole("textbox", { name: /required bills before payday/i }), "0");
    await user.click(screen.getByRole("button", { name: /^continue$/i }));

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: /your first plan has clear next steps/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 input still needs attention/i)).toBeInTheDocument();
    expect(screen.getByText(/not a simulated completion score/i)).toBeInTheDocument();

    expect(
      requests.find(({ path, method }) => path === "/api/v1/accounts" && method === "POST")?.body,
    ).toEqual(expect.objectContaining({ balanceMinorUnits: "385025", currency: "USD" }));
    expect(
      requests.find(({ path, method }) => path === "/api/v1/income-sources" && method === "POST")
        ?.body,
    ).toEqual(
      expect.objectContaining({
        cadence: "biweekly",
        typicalAmount: { minorUnits: "220000", currency: "USD" },
      }),
    );
    expect(requests.some(({ path }) => path === "/api/v1/bills")).toBe(false);
    expect(
      requests.some(
        ({ path, method, body }) =>
          path === "/api/v1/reports/dashboard/preferences" &&
          method === "PATCH" &&
          JSON.stringify(body).includes('"targetLiquidNetWorth":{"minorUnits":"25000000"'),
      ),
    ).toBe(true);
    expect(
      requests.some(
        ({ path, method, body }) =>
          path === "/api/v1/reports/dashboard/preferences" &&
          method === "PATCH" &&
          JSON.stringify(body).includes('"minimumBuffer":{"minorUnits":"100000"') &&
          JSON.stringify(body).includes('"reservedBills":{"minorUnits":"0"'),
      ),
    ).toBe(true);
  });
});

describe("Today weekly action", () => {
  beforeEach(installMatchMedia);

  it("annualizes the monthly pace and subtracts only contributions from the current week", () => {
    const goal: ApiGoal = {
      id: "goal-1",
      name: "Emergency fund",
      type: "emergency_fund",
      target: { minorUnits: "1000000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "52000", currency: "USD" },
      priority: 1,
      paused: false,
    };
    const contributions: ApiGoalContribution[] = [
      {
        id: "this-week",
        goalId: goal.id,
        amount: { minorUnits: "6000", currency: "USD" },
        contributedOn: "2026-07-14",
      },
      {
        id: "last-week",
        goalId: goal.id,
        amount: { minorUnits: "5000", currency: "USD" },
        contributedOn: "2026-07-10",
      },
    ];

    expect(
      deriveWeeklyGoalAction(
        goal,
        { minorUnits: "30000" },
        contributions,
        new Date("2026-07-15T12:00:00"),
      ),
    ).toEqual({
      suggestedMinorUnits: "6000",
      remainingMinorUnits: "900000",
      recordedMinorUnits: "6000",
    });
  });

  it("previews a reserve-backed action without pretending it spends cash or mutates demo data", async () => {
    window.sessionStorage.setItem("bw-demo", "true");
    const user = userEvent.setup();
    renderPage(<TodayPage />, "/today");

    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(screen.queryByText(/% ready/i)).not.toBeInTheDocument();
    const moneyLoop = screen.getByTestId("today-money-loop");
    expect(
      within(moneyLoop).getByRole("heading", { name: /paycheck-to-freedom loop/i }),
    ).toBeInTheDocument();
    expect(within(moneyLoop).getByText("Pay cycle mapped")).toBeInTheDocument();
    expect(within(moneyLoop).getByText("1 to resolve")).toBeInTheDocument();
    expect(
      within(moneyLoop).getByText(/funding projection, not purchase permission/i),
    ).toBeInTheDocument();
    expect(within(moneyLoop).getByText(/plan surplus \$150/i)).toBeInTheDocument();
    expect(screen.getByText(/this week: earmark/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /preview impact/i }));

    const dialog = screen.getByRole("dialog", { name: /preview weekly action/i });
    expect(within(dialog).getByText(/does not move money at your bank/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/safe to spend stays unchanged/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /demo preview only/i })).toBeDisabled();
    expect(within(dialog).getAllByText("$612").length).toBeGreaterThan(0);
  });

  it("does not expose the recommended amount when privacy mode is already enabled", async () => {
    window.sessionStorage.setItem("bw-demo", "true");
    window.localStorage.setItem("bw-privacy", "true");
    renderPage(<TodayPage />, "/today");

    await waitFor(() =>
      expect(screen.getAllByLabelText("Amount hidden").length).toBeGreaterThan(8),
    );
    expect(screen.queryByText("$150")).not.toBeInTheDocument();
  });
});
