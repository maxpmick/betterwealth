import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { AppProviders } from "../contexts";
import { SettingsPage } from "../pages/SettingsPage";

function renderSettings(section = "integrations") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppProviders>
        <MemoryRouter initialEntries={[`/settings?section=${section}`]}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/transactions" element={<h1>Transaction import destination</h1>} />
          </Routes>
        </MemoryRouter>
      </AppProviders>
    </QueryClientProvider>,
  );
}

const renderIntegrations = () => renderSettings("integrations");

describe("Integration settings", () => {
  beforeEach(() => {
    window.sessionStorage.setItem("bw-demo", "true");
    window.localStorage.clear();
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
    expect(
      within(dialog).getByRole("switch", {
        name: /automatically research uncertain merchants on the public web/i,
      }),
    ).not.toBeChecked();
    expect(dialog).toHaveTextContent(/only the merchant name or statement descriptor/i);
    expect(dialog).toHaveTextContent(/openrouter may charge separately for web search/i);
    const save = within(dialog).getByRole("button", {
      name: /apply configuration preview/i,
    });
    expect(save).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/^api key$/i), "synthetic-test-key");
    expect(save).toBeEnabled();
    expect(dialog).not.toHaveTextContent("synthetic-test-key");
  });

  it("reflects saved merchant research consent and sends explicit changes", async () => {
    window.sessionStorage.removeItem("bw-demo");
    vi.spyOn(api, "integrationSettings").mockResolvedValue({
      ai: {
        enabled: true,
        provider: "openrouter",
        model: "tencent/hy3:free",
        consentedFields: ["normalized_description"],
      },
      exchangeRates: { provider: "manual", enabled: false },
      valuations: { providers: ["manual"] },
    });
    vi.spyOn(api, "connections").mockResolvedValue({
      data: [],
      page: { cursor: null, hasMore: false },
    });
    vi.spyOn(api, "aiIntegrationConfig").mockResolvedValue({
      configured: true,
      enabled: true,
      baseUrl: "https://openrouter.ai/api/v1",
      model: "tencent/hy3:free",
      confidenceThreshold: 0.9,
      webResearchEnabled: true,
    });
    const update = vi.spyOn(api, "updateAiIntegrationConfig").mockResolvedValue({
      configured: true,
      enabled: true,
      baseUrl: "https://openrouter.ai/api/v1",
      model: "tencent/hy3:free",
      confidenceThreshold: 0.9,
      webResearchEnabled: false,
    });
    const user = userEvent.setup();
    renderIntegrations();

    expect(await screen.findByText("Public merchant web research")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /edit configuration/i }));
    const dialog = screen.getByRole("dialog", { name: /configure ai categorization/i });
    const research = within(dialog).getByRole("switch", {
      name: /automatically research uncertain merchants on the public web/i,
    });
    expect(research).toBeChecked();

    await user.click(research);
    await user.click(within(dialog).getByRole("button", { name: /save encrypted configuration/i }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ webResearchEnabled: false })),
    );
  });

  it("rejects arbitrary compatibility hosts before AI configuration is submitted", async () => {
    const user = userEvent.setup();
    renderIntegrations();

    await user.click(screen.getByRole("button", { name: /^configure$/i }));
    const dialog = screen.getByRole("dialog", { name: /configure ai categorization/i });
    const baseUrl = within(dialog).getByRole("textbox", { name: /base url/i });
    await user.clear(baseUrl);
    await user.type(baseUrl, "https://rebinding.attacker.example/v1");
    await user.type(within(dialog).getByLabelText(/^api key$/i), "synthetic-test-key");

    expect(within(dialog).getByText(/use https with openrouter, openai, groq/i)).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: /apply configuration preview/i }),
    ).toBeDisabled();
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

  it("renders roadmap integrations as status, never dead buttons", () => {
    renderIntegrations();

    expect(screen.queryByText("Exchange rates")).toBeNull();
    expect(screen.queryByRole("button", { name: /configure provider|coming soon/i })).toBeNull();
  });

  it("never accepts a real SimpleFIN credential in the example session", async () => {
    const user = userEvent.setup();
    renderIntegrations();

    await user.click(screen.getByRole("button", { name: /connect simplefin/i }));
    const dialog = screen.getByRole("dialog", { name: /connect simplefin/i });
    expect(dialog).toHaveTextContent(/credentials are never accepted or retained/i);
    expect(within(dialog).queryByRole("textbox", { name: /setup token/i })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /claim/i })).toBeNull();
  });

  it("makes profile saving a truthful session-local preview in demo mode", async () => {
    const user = userEvent.setup();
    renderSettings("profile");

    const name = await screen.findByRole("textbox", { name: /^name$/i });
    await user.clear(name);
    await user.type(name, "Future Alex");
    await user.click(screen.getByRole("button", { name: /save profile/i }));

    expect(screen.getByText(/preview updated for this demo session/i)).toBeVisible();
  });

  it("explains signed-in security actions instead of rendering demo no-ops", () => {
    renderSettings("security");

    expect(screen.getByRole("heading", { name: /change password/i })).toBeVisible();
    expect(screen.getByText(/password changes apply to a signed-in/i)).toBeVisible();
    expect(screen.queryByLabelText(/current password/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /revoke all/i })).toBeNull();
  });

  it("offers only appearance controls that immediately persist", async () => {
    const user = userEvent.setup();
    renderSettings("appearance");

    await user.click(screen.getByRole("radio", { name: /dark/i }));
    expect(window.localStorage.getItem("bw-theme")).toBe("dark");
    await user.click(screen.getByRole("switch", { name: /mask money by default/i }));
    expect(window.localStorage.getItem("bw-privacy")).toBe("true");
    expect(screen.queryByText(/reduce motion|number format|date format/i)).toBeNull();
  });

  it.each([
    ["household", /household members/i, /invite member|membership administration/i],
    ["security", /change password/i, /add passkey|connect oauth|create token|future sign-in/i],
    ["data", /data export/i, /delete household/i],
    ["health", /runtime diagnostics/i, /create sanitized bundle|support bundle/i],
  ])("keeps %s focused on implemented controls", (section, implemented, roadmap) => {
    renderSettings(section);

    expect(screen.getAllByText(implemented).length).toBeGreaterThan(0);
    expect(screen.queryByText(roadmap)).toBeNull();
    expect(screen.queryByRole("button", { name: roadmap })).toBeNull();
  });
});
