import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../contexts";
import { BudgetPage } from "../pages/BudgetPage";

function renderPage(path = "/budget") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppProviders>
        <MemoryRouter initialEntries={[path]}>
          <BudgetPage />
        </MemoryRouter>
      </AppProviders>
    </QueryClientProvider>,
  );
}

describe("Budget planning", () => {
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

  it("renders only computed plan totals and priority funding rows", async () => {
    renderPage();

    expect(
      screen.getByRole("heading", { level: 1, name: /a job for every dollar/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Plan surplus")).toBeInTheDocument();
    const paycheckFlow = screen.getByTestId("budget-paycheck-flow");
    expect(
      within(paycheckFlow).getByRole("heading", { name: /from paycheck to free cash/i }),
    ).toBeInTheDocument();
    expect(within(paycheckFlow).getByText("Priority protected")).toBeInTheDocument();
    expect(within(paycheckFlow).getByText("Available for goals")).toBeInTheDocument();
    expect(within(paycheckFlow).getByRole("link", { name: /tighten matching/i })).toHaveAttribute(
      "href",
      "/automation",
    );
    expect(screen.getByText(/plan total/i)).toBeInTheDocument();
    expect(screen.getAllByText(/priority \d+/i).length).toBeGreaterThan(2);
    expect(screen.getByText(/funding plus transfers and confirmed refunds/i)).toBeInTheDocument();
  });

  it("previews the saved envelopes instead of a hard-coded funding order", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /fund paycheck/i }));
    const dialog = screen.getByRole("dialog", { name: /fund jul 16–jul 30/i });
    expect(within(dialog).getByText("Rent")).toBeInTheDocument();
    expect(within(dialog).getByText("Groceries")).toBeInTheDocument();
    expect(within(dialog).getByText("Assigned to envelopes")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /commit allocation/i })).toBeDisabled();
  });

  it("converts monthly estimates visibly and honors the quick-add URL", async () => {
    const user = userEvent.setup();
    const rendered = renderPage();

    await user.click(screen.getByRole("button", { name: /build from monthly spend/i }));
    const planDialog = screen.getByRole("dialog", { name: /build from monthly spending/i });
    const housingCard = within(planDialog).getByDisplayValue("Housing").closest(".MuiCard-root");
    expect(housingCard).not.toBeNull();
    await user.type(
      within(housingCard as HTMLElement).getByRole("textbox", { name: /monthly amount/i }),
      "2600",
    );
    expect(
      within(housingCard as HTMLElement).getByText(/\$1,200\.00 per paycheck/i),
    ).toBeInTheDocument();

    rendered.unmount();
    renderPage("/budget?action=add-envelope");
    expect(await screen.findByRole("dialog", { name: /new envelope/i })).toBeInTheDocument();
  });
});
