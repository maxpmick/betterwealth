import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../App";
import type { TrustState } from "../api";
import { TrustStatePanel } from "../components/ui";
import { AppProviders } from "../contexts";

function installMatchMedia(width: number) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => {
      const max = query.match(/max-width:\s*([\d.]+)px/);
      const min = query.match(/min-width:\s*([\d.]+)px/);
      const matches = query.includes("prefers-color-scheme")
        ? false
        : (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    },
  });
}

function renderApp(path: string, width = 1280, registrationMode: "open" | "closed" = "open") {
  installMatchMedia(width);
  window.sessionStorage.setItem("bw-demo", "true");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes("/api/v1/capabilities")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              registration: {
                mode: registrationMode,
                selfService: registrationMode === "open",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return new Promise<Response>(() => undefined);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppProviders>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProviders>
    </QueryClientProvider>,
  );
}

describe("BetterWealth routing and shell", () => {
  it("navigates between primary finance destinations", async () => {
    const user = userEvent.setup();
    renderApp("/today");

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: /good (?:morning|afternoon|evening), alex/i,
      }),
    ).toBeInTheDocument();
    const desktop = await screen.findByRole("navigation", { name: /primary navigation/i });
    await user.click(within(desktop).getByRole("link", { name: /transactions/i }));

    expect(screen.getByRole("heading", { level: 1, name: "Transactions" })).toBeInTheDocument();
  });

  it("routes global search commands into their concrete page state", async () => {
    const user = userEvent.setup();
    renderApp("/today");

    await user.click(await screen.findByRole("button", { name: /^search$/i }));
    const palette = screen.getByRole("dialog", { name: /find anything/i });
    await user.click(within(palette).getByText("Review transactions"));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Transactions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /review/i })).toHaveAttribute("aria-selected", "true");
  });

  it("opens real quick-add workflows and labels demo sync as unavailable", async () => {
    const user = userEvent.setup();
    renderApp("/today");

    const syncButtons = await screen.findAllByRole("button", {
      name: /sync unavailable for demo data/i,
    });
    expect(syncButtons.length).toBeGreaterThan(0);
    for (const button of syncButtons) expect(button).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /quick add/i }));
    await user.click(screen.getByRole("menuitem", { name: /add transaction/i }));

    expect(await screen.findByRole("dialog", { name: /add a transaction/i })).toBeVisible();
  });

  it("cycles and persists the global appearance preference", async () => {
    window.localStorage.setItem("bw-theme", "system");
    const user = userEvent.setup();
    renderApp("/today");

    await user.click(await screen.findByRole("button", { name: /theme is system; change theme/i }));
    expect(window.localStorage.getItem("bw-theme")).toBe("light");
    expect(
      screen.getByRole("button", { name: /theme is light; change theme/i }),
    ).toBeInTheDocument();
  });

  it("exposes exactly the contracted five-item mobile navigation at 320px", async () => {
    renderApp("/budget", 320);

    const mobile = await screen.findByRole("navigation", { name: /mobile navigation/i });
    expect(within(mobile).getAllByRole("button")).toHaveLength(5);
    for (const label of ["Today", "Transactions", "Budget", "Goals", "More"]) {
      expect(within(mobile).getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 1, name: /a job for every dollar/i }),
    ).toBeInTheDocument();
  });

  it("moves from login to registration without losing keyboard-friendly form semantics", async () => {
    const user = userEvent.setup();
    renderApp("/login");

    expect(
      await screen.findByRole("heading", { level: 1, name: /welcome back/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /email address/i })).toHaveAttribute(
      "autocomplete",
      "email",
    );
    await user.click(await screen.findByRole("link", { name: /create an account/i }));

    expect(
      await screen.findByRole("heading", { level: 1, name: /build your better plan/i }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /create secure account/i })).toHaveAttribute(
      "type",
      "submit",
    );
  });

  it("removes dead signup paths when the self-hosted instance is closed", async () => {
    const rendered = renderApp("/login", 1280, "closed");

    expect(await screen.findByText(/new account creation is closed/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /create an account/i })).not.toBeInTheDocument();
    expect(screen.getByText(/example scenario · not your forecast/i)).toBeInTheDocument();

    rendered.unmount();
    renderApp("/register", 1280, "closed");
    expect(
      await screen.findByRole("heading", { level: 1, name: /account creation is closed/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /create secure account/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to sign in/i })).toHaveAttribute(
      "href",
      "/login",
    );
  });
});

describe("privacy and trust", () => {
  it("removes secret amounts from the DOM when privacy mode is enabled", async () => {
    const user = userEvent.setup();
    renderApp("/today");

    expect((await screen.findAllByText("$612")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /hide monetary values/i }));

    expect(screen.queryByText("$612")).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Amount hidden").length).toBeGreaterThan(5);
    expect(screen.getByText(/chart values are hidden/i)).toBeInTheDocument();
  });

  it.each<TrustState>(["ready", "incomplete", "stale"])(
    "renders the %s safe-to-spend trust state with text, not color alone",
    (state) => {
      installMatchMedia(900);
      render(
        <AppProviders>
          <TrustStatePanel
            state={state}
            asOf="10:42 AM"
            pendingImpact={-48.16}
            missingInputs={state === "ready" ? [] : ["fresh balance"]}
            onCorrect={vi.fn()}
          />
        </AppProviders>,
      );

      const panel = screen.getByTestId("trust-state");
      expect(panel).toHaveAttribute("data-state", state);
      expect(
        within(panel).getByText(
          state === "ready" ? "Ready" : state === "incomplete" ? "Incomplete" : "Stale",
        ),
      ).toBeInTheDocument();
      if (state !== "ready")
        expect(within(panel).getByRole("button", { name: /correct now/i })).toBeInTheDocument();
    },
  );
});
