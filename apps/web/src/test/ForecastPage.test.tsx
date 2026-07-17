import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitForElementToBeRemoved, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../contexts";
import { ForecastPage } from "../pages/ForecastPage";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppProviders>
        <MemoryRouter>
          <ForecastPage />
        </MemoryRouter>
      </AppProviders>
    </QueryClientProvider>,
  );
}

describe("Forecast planning", () => {
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

  it("offers an honest, interactive forecast preview", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(
      screen.getByRole("heading", { level: 1, name: /see where today’s plan can lead/i }),
    ).toBeVisible();
    expect(screen.getByText(/interactive preview: create scenarios/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /run preview/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /new scenario/i }));
    const dialog = screen.getByRole("dialog", { name: /new forecast scenario/i });
    const create = within(dialog).getByRole("button", { name: /create scenario/i });
    expect(create).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox", { name: /scenario name/i }), "Career leap");
    expect(create).toBeEnabled();
    await user.click(create);
    await waitForElementToBeRemoved(dialog);

    expect(await screen.findByRole("tab", { name: /career leap/i })).toBeVisible();
    expect(
      screen.getByText(/career leap was added to this interactive demo session/i),
    ).toBeVisible();
    expect(screen.getByText(/no completed run for this scenario/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: /run preview/i }));
    expect(screen.getByText(/career leap preview recalculated/i)).toBeVisible();
    expect(screen.queryByText(/no completed run for this scenario/i)).toBeNull();
  });
});
