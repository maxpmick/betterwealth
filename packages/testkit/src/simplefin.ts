export interface SimpleFinV1TransactionFixture {
  readonly id: string;
  readonly posted: number;
  readonly amount: string;
  readonly description: string;
  readonly transacted_at?: number;
  readonly pending?: boolean;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface SimpleFinV1AccountFixture {
  readonly org: {
    readonly domain: string;
    readonly name: string;
    readonly "sfin-url": string;
  };
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly balance: string;
  readonly "available-balance"?: string;
  readonly "balance-date": number;
  readonly transactions?: readonly SimpleFinV1TransactionFixture[];
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface SimpleFinV2AccountFixture extends Omit<SimpleFinV1AccountFixture, "org"> {
  readonly conn_id: string;
}

const checkingTransactions = Object.freeze([
  Object.freeze({
    id: "payroll-2026-07-31",
    posted: 1_775_174_400,
    transacted_at: 1_775_138_400,
    amount: "2600.00",
    description: "ACME DIGITAL PAYROLL 073126",
    extra: { category: "income", payee: "Acme Digital" },
  }),
  Object.freeze({
    id: "rent-2026-08",
    posted: 1_775_260_800,
    transacted_at: 1_775_260_800,
    amount: "-1450.00",
    description: "ACH RIVER WALK APTS RENT",
    extra: { category: "rent" },
  }),
  Object.freeze({
    id: "transfer-savings-0731-out",
    posted: 1_775_174_400,
    amount: "-500.00",
    description: "TRANSFER TO SAVINGS 8801",
    extra: { transfer_pair: "alex-transfer-0731" },
  }),
  Object.freeze({
    id: "student-loan-0729",
    posted: 1_775_001_600,
    amount: "-550.00",
    description: "US DEPT ED LOAN PMT",
  }),
]);

const savingsTransactions = Object.freeze([
  Object.freeze({
    id: "transfer-savings-0731-in",
    posted: 1_775_174_400,
    amount: "500.00",
    description: "TRANSFER FROM CHECKING 2244",
    extra: { transfer_pair: "alex-transfer-0731" },
  }),
]);

const cardTransactions = Object.freeze([
  Object.freeze({
    id: "fresh-market-0730",
    posted: 1_775_088_000,
    transacted_at: 1_775_052_000,
    amount: "-84.23",
    description: "FRESH MARKET 0042",
  }),
  Object.freeze({
    id: "corner-coffee-0730",
    posted: 1_775_088_000,
    amount: "-4.25",
    description: "SQ *CORNER COFFEE #42",
  }),
  Object.freeze({
    id: "transit-pending-0801",
    posted: 0,
    transacted_at: 1_775_260_800,
    amount: "-12.75",
    description: "PENDING TRANSIT FARE",
    pending: true,
  }),
]);

export const simpleFinV1Fixture = Object.freeze({
  errors: Object.freeze([]),
  accounts: Object.freeze([
    Object.freeze({
      org: Object.freeze({
        domain: "better-bank.example",
        name: "Better Bank",
        "sfin-url": "https://simplefin.better-bank.example",
      }),
      id: "alex-checking-2244",
      name: "Everyday Checking",
      currency: "USD",
      balance: "3850.25",
      "available-balance": "3807.75",
      "balance-date": 1_775_304_000,
      transactions: checkingTransactions,
      extra: Object.freeze({ account_type: "checking" }),
    }),
    Object.freeze({
      org: Object.freeze({
        domain: "better-bank.example",
        name: "Better Bank",
        "sfin-url": "https://simplefin.better-bank.example",
      }),
      id: "alex-savings-8801",
      name: "Emergency Savings",
      currency: "USD",
      balance: "7250.00",
      "balance-date": 1_775_304_000,
      transactions: savingsTransactions,
      extra: Object.freeze({ account_type: "savings" }),
    }),
  ]),
} satisfies {
  readonly errors: readonly string[];
  readonly accounts: readonly SimpleFinV1AccountFixture[];
});

export const simpleFinV2Fixture = Object.freeze({
  errlist: Object.freeze([]),
  connections: Object.freeze([
    Object.freeze({
      conn_id: "CON-ALEX-BETTER-BANK",
      name: "Better Bank — Alex",
      org_id: "INST-BETTER-BANK",
      org_name: "Better Bank",
      org_url: "https://better-bank.example",
      sfin_url: "https://simplefin.better-bank.example",
    }),
    Object.freeze({
      conn_id: "CON-ALEX-CARD",
      name: "Example Card — Alex",
      org_id: "INST-EXAMPLE-CARD",
      org_name: "Example Card",
      org_url: "https://example-card.example",
      sfin_url: "https://simplefin.example-card.example",
    }),
  ]),
  accounts: Object.freeze([
    Object.freeze({
      id: "alex-checking-2244",
      name: "Everyday Checking",
      conn_id: "CON-ALEX-BETTER-BANK",
      currency: "USD",
      balance: "3850.25",
      "available-balance": "3807.75",
      "balance-date": 1_775_304_000,
      transactions: checkingTransactions,
      extra: Object.freeze({ account_type: "checking" }),
    }),
    Object.freeze({
      id: "alex-savings-8801",
      name: "Emergency Savings",
      conn_id: "CON-ALEX-BETTER-BANK",
      currency: "USD",
      balance: "7250.00",
      "balance-date": 1_775_304_000,
      transactions: savingsTransactions,
      extra: Object.freeze({ account_type: "savings" }),
    }),
    Object.freeze({
      id: "alex-card-7331",
      name: "Rewards Card",
      conn_id: "CON-ALEX-CARD",
      currency: "USD",
      balance: "-630.41",
      "available-balance": "4369.59",
      "balance-date": 1_775_304_000,
      transactions: cardTransactions,
      extra: Object.freeze({ account_type: "credit-card", credit_limit: "5000.00" }),
    }),
  ]),
} satisfies {
  readonly errlist: readonly unknown[];
  readonly connections: readonly Readonly<Record<string, string>>[];
  readonly accounts: readonly SimpleFinV2AccountFixture[];
});

/** Same external transaction id on two accounts is legal and must remain distinct. */
export const simpleFinDuplicateAcrossAccountsFixture = Object.freeze({
  ...simpleFinV2Fixture,
  accounts: Object.freeze([
    Object.freeze({
      ...simpleFinV2Fixture.accounts[0]!,
      transactions: Object.freeze([
        { id: "shared-id", posted: 1_775_174_400, amount: "-20.00", description: "ACCOUNT A ITEM" },
      ]),
    }),
    Object.freeze({
      ...simpleFinV2Fixture.accounts[1]!,
      transactions: Object.freeze([
        { id: "shared-id", posted: 1_775_174_400, amount: "-20.00", description: "ACCOUNT B ITEM" },
      ]),
    }),
  ]),
});

export const simpleFinPendingRevisionFixtures = Object.freeze({
  pending: Object.freeze({
    id: "transit-pending-0801",
    posted: 0,
    transacted_at: 1_775_260_800,
    amount: "-12.75",
    description: "PENDING TRANSIT FARE",
    pending: true,
  }),
  posted: Object.freeze({
    id: "transit-posted-0802",
    posted: 1_775_347_200,
    transacted_at: 1_775_260_800,
    amount: "-12.75",
    description: "METRO TRANSIT FARE",
    extra: Object.freeze({ pending_transaction_id: "transit-pending-0801" }),
  }),
});

export const simpleFinMalformedDecimalFixture = Object.freeze({
  ...simpleFinV2Fixture,
  accounts: Object.freeze([
    Object.freeze({
      ...simpleFinV2Fixture.accounts[0]!,
      balance: "NaN",
      transactions: Object.freeze([
        {
          id: "bad-decimal",
          posted: 1_775_174_400,
          amount: "1e309",
          description: "MALFORMED AMOUNT",
        },
      ]),
    }),
  ]),
});

export const simpleFinCustomCurrencyFixture = Object.freeze({
  ...simpleFinV2Fixture,
  accounts: Object.freeze([
    Object.freeze({
      ...simpleFinV2Fixture.accounts[0]!,
      id: "alex-reward-points",
      name: "Reward Points",
      currency: "PTS",
      balance: "12500",
      transactions: Object.freeze([]),
    }),
  ]),
});

export const simpleFinErrorFixtures = Object.freeze({
  paymentRequired: Object.freeze({
    status: 402,
    body: {
      errlist: [
        {
          code: "con.payment",
          msg: "Subscription requires attention",
          conn_id: "CON-ALEX-BETTER-BANK",
        },
      ],
    },
  }),
  forbidden: Object.freeze({
    status: 403,
    body: {
      errlist: [
        { code: "con.auth", msg: "Authentication failed", conn_id: "CON-ALEX-BETTER-BANK" },
      ],
    },
  }),
  rateLimited: Object.freeze({
    status: 429,
    headers: { "retry-after": "60" },
    body: { errlist: [{ code: "server.rate_limit", msg: "Try again later" }] },
  }),
  serverError: Object.freeze({
    status: 503,
    body: { errlist: [{ code: "server.unavailable", msg: "Temporarily unavailable" }] },
  }),
  timeout: Object.freeze({ kind: "timeout", afterMs: 10_000 }),
});

export const simpleFinFixtures = Object.freeze({
  v1: simpleFinV1Fixture,
  v2: simpleFinV2Fixture,
  duplicateAcrossAccounts: simpleFinDuplicateAcrossAccountsFixture,
  pendingRevision: simpleFinPendingRevisionFixtures,
  malformedDecimal: simpleFinMalformedDecimalFixture,
  customCurrency: simpleFinCustomCurrencyFixture,
  errors: simpleFinErrorFixtures,
});
