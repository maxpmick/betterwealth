import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../contexts";
import { AutomationPage } from "../pages/AutomationPage";

function renderPage(path = "/automation") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppProviders>
        <MemoryRouter initialEntries={[path]}>
          <AutomationPage />
        </MemoryRouter>
      </AppProviders>
    </QueryClientProvider>,
  );
}

describe("Automation rules", () => {
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

  it("shows only data-backed automation sections and filters actual rules", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(
      screen.getByRole("heading", { level: 1, name: /trust is earned one narrow rule/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^rules$/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /ai review/i })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /merchants/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /recurring/i })).not.toBeInTheDocument();
    const pipeline = screen.getByTestId("automation-money-pipeline");
    expect(
      within(pipeline).getByRole("heading", { name: /from raw swipe to trusted budget/i }),
    ).toBeInTheDocument();
    expect(within(pipeline).getByText("7/9")).toBeInTheDocument();
    expect(within(pipeline).getByText(/1 ai-approved/i)).toBeInTheDocument();
    expect(within(pipeline).getByText(/78% of this ledger sample/i)).toBeInTheDocument();

    const search = screen.getByRole("textbox", { name: /search rules/i });
    await user.type(search, "payroll");
    expect(screen.getByText("Payroll income")).toBeInTheDocument();
    expect(screen.queryByText("Metro fuel")).not.toBeInTheDocument();
    await user.clear(search);
    expect(screen.getByText("Metro fuel")).toBeInTheDocument();
  });

  it("opens quick-add from the URL and requires a current server-shaped preview", async () => {
    const user = userEvent.setup();
    renderPage("/automation?action=add");

    expect(
      await screen.findByRole("heading", { name: /build a narrow rule/i }),
    ).toBeInTheDocument();
    const name = screen.getByRole("textbox", { name: /rule name/i });
    const merchant = screen.getByRole("textbox", { name: /merchant name/i });
    await user.type(name, "Corner Table dining");
    await user.type(merchant, "Corner Table");

    await user.click(screen.getByRole("combobox", { name: /action 1 category/i }));
    await user.click(screen.getByRole("option", { name: /Dining · expense/i }));
    const save = screen.getByRole("button", { name: /^save rule$/i });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /run preview/i }));
    expect(await screen.findByText(/1 historical match/i)).toBeInTheDocument();
    expect(save).toBeEnabled();

    await user.type(merchant, " updated");
    expect(screen.getByText(/the rule changed\. run the preview again/i)).toBeInTheDocument();
    expect(save).toBeDisabled();
  });

  it("loads stored rule logic for editing and adds conditions", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /edit whole foods groceries/i }));
    expect(screen.getByRole("textbox", { name: /rule name/i })).toHaveValue(
      "Whole Foods groceries",
    );
    expect(screen.getByRole("textbox", { name: /merchant name/i })).toHaveValue(
      "Whole Foods Market",
    );
    await user.click(screen.getByRole("button", { name: /add condition/i }));
    expect(screen.getByRole("combobox", { name: /condition 2 field/i })).toBeInTheDocument();
  });

  it("deletes user rules while keeping system rules read-only", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /delete metro fuel/i }));
    const dialog = screen.getByRole("dialog", { name: /delete metro fuel/i });
    expect(within(dialog).getByText(/audit history stay intact/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /^delete rule$/i }));
    await waitFor(() => expect(screen.queryByText("Metro fuel")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    expect(screen.getByRole("button", { name: /payroll income is read-only/i })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /delete payroll income/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps AI proposals approval-gated", async () => {
    const user = userEvent.setup();
    renderPage("/automation?tab=ai");

    expect(screen.getByRole("tab", { name: /ai review/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("heading", { name: "Corner Table" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /approve category only/i })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /approve \+ rule/i })).toHaveLength(2);
    const firstReject = screen.getAllByRole("button", { name: /^reject$/i }).at(0);
    expect(firstReject).toBeDefined();
    await user.click(firstReject as HTMLButtonElement);
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Corner Table" })).not.toBeInTheDocument(),
    );
  });
});
