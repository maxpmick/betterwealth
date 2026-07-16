import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../contexts";
import { SettingsPage } from "../pages/SettingsPage";

function renderIntegrations() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppProviders>
        <MemoryRouter initialEntries={["/settings?section=integrations"]}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/transactions" element={<h1>Transaction import destination</h1>} />
          </Routes>
        </MemoryRouter>
      </AppProviders>
    </QueryClientProvider>,
  );
}

describe("Integration settings", () => {
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

  it("offers encrypted per-user OpenAI-compatible configuration", async () => {
    const user = userEvent.setup();
    renderIntegrations();

    await user.click(screen.getByRole("button", { name: /^configure$/i }));
    const dialog = screen.getByRole("dialog", { name: /configure ai categorization/i });
    expect(within(dialog).getByRole("textbox", { name: /base url/i })).toHaveValue(
      "https://openrouter.ai/api/v1",
    );
    expect(within(dialog).getByRole("textbox", { name: /^model$/i })).toHaveValue(
      "tencent/hy3:free",
    );
    const save = within(dialog).getByRole("button", { name: /save encrypted configuration/i });
    expect(save).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/^api key$/i), "synthetic-test-key");
    expect(save).toBeEnabled();
    expect(dialog).not.toHaveTextContent("synthetic-test-key");
  });

  it("routes the available file import into the transaction workflow", async () => {
    const user = userEvent.setup();
    renderIntegrations();

    await user.click(screen.getByRole("button", { name: /import transactions/i }));
    expect(
      screen.getByRole("heading", { level: 1, name: /transaction import destination/i }),
    ).toBeInTheDocument();
  });

  it("does not leave AI consent enabled when first-time configuration is cancelled", async () => {
    const user = userEvent.setup();
    renderIntegrations();

    const consent = screen.getByRole("switch", {
      name: /allow bounded ai categorization requests/i,
    });
    expect(consent).not.toBeChecked();
    await user.click(consent);
    expect(screen.getByRole("dialog", { name: /configure ai categorization/i })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(consent).not.toBeChecked();
  });
});
