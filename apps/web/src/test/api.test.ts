import { describe, expect, it, vi } from "vitest";
import { API_BASE, api } from "../api";

describe("API boundary", () => {
  it("uses the versioned same-origin API path", () => {
    expect(API_BASE).toBe("/api/v1");
  });

  it("keeps financial JSON amounts as base-10 strings", () => {
    const transport = { minorUnits: "-4816", currency: "USD" };
    expect(typeof transport.minorUnits).toBe("string");
    expect(Number(transport.minorUnits) / 100).toBe(-48.16);
  });

  it("uses the implemented profile password route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ changed: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.changePassword({
        currentPassword: "old password",
        newPassword: "new password long enough",
      }),
    ).resolves.toEqual({ changed: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/profile/password");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
  });

  it("maps sanitized audit events from the live operations endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "audit_1",
              actorType: "user",
              action: "profile.updated",
              entityType: "user",
              metadata: { fields: ["displayName", "targetAge"] },
              occurredAt: "2026-07-16T12:00:00.000Z",
            },
          ],
          page: { cursor: null, hasMore: false },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.auditEvents();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/audit-events");
    expect(result.data[0]).toEqual(
      expect.objectContaining({
        action: "Profile updated",
        actorLabel: "Household member",
        safeDescription: "user fields changed: displayName, targetAge",
        createdAt: "2026-07-16T12:00:00.000Z",
      }),
    );
  });

  it("downloads the implemented secret-free export with the server filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"format":"betterwealth-export-v1"}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-disposition": 'attachment; filename="betterwealth-2026-07-16.json"',
        },
      }),
    );
    const createObjectURL = vi.fn(() => "blob:betterwealth-export");
    const revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    const result = await api.downloadDataExport();

    expect(result.filename).toBe("betterwealth-2026-07-16.json");
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:betterwealth-export");
  });

  it("uses the live ledger action routes with exact minor-unit payloads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "transfer-1", status: "confirmed" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "refund-1",
            status: "confirmed",
            amount: { minorUnits: "1000", currency: "USD" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await api.replaceTransactionSplits("purchase/1", [
      { amountMinorUnits: "-500", categoryId: "food" },
      { amountMinorUnits: "-500", categoryId: "home" },
    ]);
    await api.matchTransfer({ outflowTransactionId: "outflow", inflowTransactionId: "inflow" });
    await api.linkRefund({ refundTransactionId: "refund", purchaseTransactionId: "purchase" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/transactions/purchase%2F1/splits");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          splits: [
            { amountMinorUnits: "-500", categoryId: "food" },
            { amountMinorUnits: "-500", categoryId: "home" },
          ],
        }),
      }),
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/transfers");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/refund-links");
  });

  it("loads typed account balance history from the account-scoped route", async () => {
    const body = {
      account: { id: "account/1", name: "Checking", currency: "USD" },
      data: [],
      summary: {
        current: { minorUnits: "10000", currency: "USD" },
        change: { minorUnits: "0", currency: "USD" },
        latestAsOf: null,
        reconciled: null,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.accountBalances("account/1")).resolves.toEqual(body);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/accounts/account%2F1/balances");
  });

  it("loads recent activity through an encoded account-scoped transaction query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], page: { cursor: null, hasMore: false } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.accountTransactions("account/1", 100);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/transactions?accountId=account%2F1&limit=100",
    );
  });

  it("configures a per-user AI provider without ever requesting the saved key", async () => {
    const response = {
      configured: true,
      enabled: true,
      baseUrl: "https://openrouter.ai/api/v1",
      model: "minimax/minimax-m3",
      confidenceThreshold: 0.92,
      webResearchEnabled: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.updateAiIntegrationConfig({
        enabled: true,
        consent: true,
        baseUrl: response.baseUrl,
        model: response.model,
        apiKey: "test-provider-key",
        confidenceThreshold: response.confidenceThreshold,
        webResearchEnabled: false,
      }),
    ).resolves.toEqual(response);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/settings/integrations/ai");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          consent: true,
          baseUrl: response.baseUrl,
          model: response.model,
          apiKey: "test-provider-key",
          confidenceThreshold: response.confidenceThreshold,
          webResearchEnabled: false,
        }),
      }),
    );
    expect(response).not.toHaveProperty("apiKey");
  });

  it("regenerates an AI proposal with explicit correction and merchant research consent", async () => {
    const response = {
      id: "suggestion/1",
      transactionId: "transaction-1",
      merchant: "Corner Table",
      categoryId: "category-groceries",
      categoryName: "Groceries",
      categoryPath: ["Everyday", "Groceries"],
      confidence: 0.96,
      rationale: "The correction identifies this as a grocery merchant.",
      proposedRule: {
        name: "Corner Table → Groceries",
        conditions: {},
        actions: {},
      },
      status: "pending",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.regenerateAiSuggestion("suggestion/1", {
        feedback: "This is my weekly grocery store.",
        allowWebResearch: true,
      }),
    ).resolves.toEqual(response);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/ai/suggestions/suggestion%2F1/regenerate");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          feedback: "This is my weekly grocery store.",
          allowWebResearch: true,
        }),
      }),
    );
  });
});
