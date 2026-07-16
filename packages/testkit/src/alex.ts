import {
  type Account,
  AccountSchema,
  calculateSafeToSpend,
  type Envelope,
  EnvelopeSchema,
  type ForecastScenario,
  type Goal,
  GoalSchema,
  type MonteCarloInput,
  money,
  moneyToJson,
  type Transaction,
  TransactionSchema,
} from "@betterwealth/shared";

export function fixtureUlid(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError("Fixture ULID sequence is out of range");
  }
  return `01J0000000${sequence.toString().padStart(16, "0")}`;
}

export const ALEX_IDS = Object.freeze({
  user: fixtureUlid(1),
  household: fixtureUlid(2),
  connection: fixtureUlid(3),
  checking: fixtureUlid(10),
  savings: fixtureUlid(11),
  brokerage: fixtureUlid(12),
  retirement: fixtureUlid(13),
  studentLoan: fixtureUlid(14),
  creditCard: fixtureUlid(15),
  merchantEmployer: fixtureUlid(30),
  merchantLandlord: fixtureUlid(31),
  merchantGrocer: fixtureUlid(32),
  merchantCoffee: fixtureUlid(33),
  merchantGym: fixtureUlid(34),
  categoryIncome: fixtureUlid(40),
  categoryHousing: fixtureUlid(41),
  categoryGroceries: fixtureUlid(42),
  categoryDining: fixtureUlid(43),
  categoryDebt: fixtureUlid(44),
  categoryFitness: fixtureUlid(45),
  categoryTransfer: fixtureUlid(46),
  envelopeRent: fixtureUlid(50),
  envelopeUtilities: fixtureUlid(51),
  envelopeGroceries: fixtureUlid(52),
  envelopeTransport: fixtureUlid(53),
  envelopeDebt: fixtureUlid(54),
  envelopeEmergency: fixtureUlid(55),
  envelopeInvesting: fixtureUlid(56),
  envelopeFun: fixtureUlid(57),
  goalEmergency: fixtureUlid(60),
  goalCar: fixtureUlid(61),
  goalDebtFree: fixtureUlid(62),
  goalAge30: fixtureUlid(63),
  transfer: fixtureUlid(70),
  txPaycheck: fixtureUlid(100),
  txRent: fixtureUlid(101),
  txGroceries: fixtureUlid(102),
  txCoffee: fixtureUlid(103),
  txTransferOut: fixtureUlid(104),
  txTransferIn: fixtureUlid(105),
  txDebt: fixtureUlid(106),
  txGym: fixtureUlid(107),
  txPending: fixtureUlid(108),
});

const createdAt = "2026-08-01T12:00:00.000Z";

function account(input: {
  id: string;
  name: string;
  mask: string;
  type: Account["type"];
  subtype: string;
  balanceMinor: string;
  availableMinor?: string;
  includeInBudget: boolean;
}): Account {
  return AccountSchema.parse({
    id: input.id,
    householdId: ALEX_IDS.household,
    connectionId: ALEX_IDS.connection,
    institutionId: "better-bank",
    name: input.name,
    mask: input.mask,
    type: input.type,
    subtype: input.subtype,
    currency: "USD",
    currentBalance: { minorUnits: input.balanceMinor, currency: "USD" },
    availableBalance:
      input.availableMinor === undefined
        ? null
        : { minorUnits: input.availableMinor, currency: "USD" },
    ownership: "individual",
    includeInBudget: input.includeInBudget,
    includeInNetWorth: true,
    archived: false,
    lastSyncedAt: "2026-08-01T11:55:00.000Z",
    createdAt,
    updatedAt: createdAt,
  });
}

export const alexAccounts: readonly Account[] = Object.freeze([
  account({
    id: ALEX_IDS.checking,
    name: "Everyday Checking",
    mask: "2244",
    type: "checking",
    subtype: "checking",
    balanceMinor: "385025",
    availableMinor: "385025",
    includeInBudget: true,
  }),
  account({
    id: ALEX_IDS.savings,
    name: "Emergency Savings",
    mask: "8801",
    type: "savings",
    subtype: "highYieldSavings",
    balanceMinor: "725000",
    includeInBudget: true,
  }),
  account({
    id: ALEX_IDS.brokerage,
    name: "Taxable Brokerage",
    mask: "9910",
    type: "investment",
    subtype: "brokerage",
    balanceMinor: "340000",
    includeInBudget: false,
  }),
  account({
    id: ALEX_IDS.retirement,
    name: "Employer 401(k)",
    mask: "4010",
    type: "retirement",
    subtype: "401k",
    balanceMinor: "980000",
    includeInBudget: false,
  }),
  account({
    id: ALEX_IDS.studentLoan,
    name: "Federal Student Loan",
    mask: "1032",
    type: "loan",
    subtype: "studentLoan",
    balanceMinor: "-1460000",
    includeInBudget: false,
  }),
  account({
    id: ALEX_IDS.creditCard,
    name: "Rewards Card",
    mask: "7331",
    type: "creditCard",
    subtype: "creditCard",
    balanceMinor: "-63041",
    availableMinor: "436959",
    includeInBudget: true,
  }),
]);

type TransactionOverrides = Partial<Transaction> &
  Pick<
    Transaction,
    "id" | "accountId" | "amount" | "postedDate" | "rawDescription" | "normalizedDescription"
  >;

function transaction(input: TransactionOverrides): Transaction {
  return TransactionSchema.parse({
    householdId: ALEX_IDS.household,
    externalId: `simplefin-${input.id}`,
    authorizedDate: input.postedDate,
    merchantId: null,
    merchantName: null,
    categoryId: null,
    envelopeId: null,
    status: "posted",
    source: "simplefin",
    needsReview: false,
    excludedFromBudget: false,
    excludedFromReports: false,
    isTransfer: false,
    isIncome: false,
    transferId: null,
    refundTransactionId: null,
    recurringSeriesId: null,
    note: null,
    tagIds: [],
    splits: [],
    createdAt,
    updatedAt: createdAt,
    ...input,
  });
}

export const alexTransactions: readonly Transaction[] = Object.freeze([
  transaction({
    id: ALEX_IDS.txPaycheck,
    accountId: ALEX_IDS.checking,
    amount: { minorUnits: "260000", currency: "USD" },
    postedDate: "2026-07-31",
    rawDescription: "ACME DIGITAL PAYROLL 073126",
    normalizedDescription: "Acme Digital Payroll",
    merchantId: ALEX_IDS.merchantEmployer,
    merchantName: "Acme Digital",
    categoryId: ALEX_IDS.categoryIncome,
    isIncome: true,
  }),
  transaction({
    id: ALEX_IDS.txRent,
    accountId: ALEX_IDS.checking,
    amount: { minorUnits: "-145000", currency: "USD" },
    postedDate: "2026-08-01",
    rawDescription: "ACH RIVER WALK APTS RENT",
    normalizedDescription: "River Walk Apartments",
    merchantId: ALEX_IDS.merchantLandlord,
    merchantName: "River Walk Apartments",
    categoryId: ALEX_IDS.categoryHousing,
    envelopeId: ALEX_IDS.envelopeRent,
  }),
  transaction({
    id: ALEX_IDS.txGroceries,
    accountId: ALEX_IDS.creditCard,
    amount: { minorUnits: "-8423", currency: "USD" },
    postedDate: "2026-07-30",
    rawDescription: "FRESH MARKET 0042",
    normalizedDescription: "Fresh Market",
    merchantId: ALEX_IDS.merchantGrocer,
    merchantName: "Fresh Market",
    categoryId: ALEX_IDS.categoryGroceries,
    envelopeId: ALEX_IDS.envelopeGroceries,
  }),
  transaction({
    id: ALEX_IDS.txCoffee,
    accountId: ALEX_IDS.creditCard,
    amount: { minorUnits: "-425", currency: "USD" },
    postedDate: "2026-07-30",
    rawDescription: "SQ *CORNER COFFEE #42",
    normalizedDescription: "Corner Coffee",
    merchantId: ALEX_IDS.merchantCoffee,
    merchantName: "Corner Coffee",
    categoryId: ALEX_IDS.categoryDining,
    envelopeId: ALEX_IDS.envelopeFun,
  }),
  transaction({
    id: ALEX_IDS.txTransferOut,
    accountId: ALEX_IDS.checking,
    amount: { minorUnits: "-50000", currency: "USD" },
    postedDate: "2026-07-31",
    rawDescription: "TRANSFER TO SAVINGS 8801",
    normalizedDescription: "Transfer to Savings",
    categoryId: ALEX_IDS.categoryTransfer,
    excludedFromBudget: true,
    excludedFromReports: true,
    isTransfer: true,
    transferId: ALEX_IDS.transfer,
  }),
  transaction({
    id: ALEX_IDS.txTransferIn,
    accountId: ALEX_IDS.savings,
    amount: { minorUnits: "50000", currency: "USD" },
    postedDate: "2026-07-31",
    rawDescription: "TRANSFER FROM CHECKING 2244",
    normalizedDescription: "Transfer from Checking",
    categoryId: ALEX_IDS.categoryTransfer,
    excludedFromBudget: true,
    excludedFromReports: true,
    isTransfer: true,
    transferId: ALEX_IDS.transfer,
  }),
  transaction({
    id: ALEX_IDS.txDebt,
    accountId: ALEX_IDS.checking,
    amount: { minorUnits: "-55000", currency: "USD" },
    postedDate: "2026-07-29",
    rawDescription: "US DEPT ED LOAN PMT",
    normalizedDescription: "Federal Student Loan",
    categoryId: ALEX_IDS.categoryDebt,
    envelopeId: ALEX_IDS.envelopeDebt,
  }),
  transaction({
    id: ALEX_IDS.txGym,
    accountId: ALEX_IDS.creditCard,
    amount: { minorUnits: "-3500", currency: "USD" },
    postedDate: "2026-07-28",
    rawDescription: "CITY FIT CLUB MONTHLY",
    normalizedDescription: "City Fit Club",
    merchantId: ALEX_IDS.merchantGym,
    merchantName: "City Fit Club",
    categoryId: ALEX_IDS.categoryFitness,
    envelopeId: ALEX_IDS.envelopeFun,
  }),
  transaction({
    id: ALEX_IDS.txPending,
    accountId: ALEX_IDS.creditCard,
    amount: { minorUnits: "-1275", currency: "USD" },
    postedDate: "2026-08-01",
    rawDescription: "PENDING TRANSIT FARE",
    normalizedDescription: "Metro Transit",
    status: "pending",
    needsReview: true,
    categoryId: null,
  }),
]);

function envelope(input: {
  id: string;
  categoryId?: string;
  name: string;
  priority: number;
  priorityClass: Envelope["priorityClass"];
  targetMinor: string;
  fundedMinor: string;
  activityMinor?: string;
}): Envelope {
  const activity = BigInt(input.activityMinor ?? "0");
  const available = BigInt(input.fundedMinor) - activity;
  return EnvelopeSchema.parse({
    id: input.id,
    householdId: ALEX_IDS.household,
    parentId: null,
    categoryId: input.categoryId ?? null,
    name: input.name,
    cadence: "payCycle",
    rolloverPolicy: "positive",
    priority: input.priority,
    priorityClass: input.priorityClass,
    minimum: { minorUnits: input.targetMinor, currency: "USD" },
    target: { minorUnits: input.targetMinor, currency: "USD" },
    planned: { minorUnits: input.targetMinor, currency: "USD" },
    funded: { minorUnits: input.fundedMinor, currency: "USD" },
    activity: { minorUnits: activity.toString(), currency: "USD" },
    available: { minorUnits: available.toString(), currency: "USD" },
    archived: false,
  });
}

export const alexEnvelopes: readonly Envelope[] = Object.freeze([
  envelope({
    id: ALEX_IDS.envelopeRent,
    categoryId: ALEX_IDS.categoryHousing,
    name: "Rent",
    priority: 100,
    priorityClass: "requiredBills",
    targetMinor: "72500",
    fundedMinor: "72500",
  }),
  envelope({
    id: ALEX_IDS.envelopeUtilities,
    name: "Utilities",
    priority: 90,
    priorityClass: "requiredBills",
    targetMinor: "10000",
    fundedMinor: "10000",
  }),
  envelope({
    id: ALEX_IDS.envelopeGroceries,
    categoryId: ALEX_IDS.categoryGroceries,
    name: "Groceries",
    priority: 80,
    priorityClass: "coreLiving",
    targetMinor: "25000",
    fundedMinor: "25000",
    activityMinor: "8423",
  }),
  envelope({
    id: ALEX_IDS.envelopeTransport,
    name: "Transportation",
    priority: 75,
    priorityClass: "coreLiving",
    targetMinor: "15000",
    fundedMinor: "15000",
    activityMinor: "1275",
  }),
  envelope({
    id: ALEX_IDS.envelopeDebt,
    categoryId: ALEX_IDS.categoryDebt,
    name: "Student Loan",
    priority: 85,
    priorityClass: "minimumDebt",
    targetMinor: "27500",
    fundedMinor: "27500",
  }),
  envelope({
    id: ALEX_IDS.envelopeEmergency,
    name: "Emergency Fund",
    priority: 70,
    priorityClass: "buffer",
    targetMinor: "15000",
    fundedMinor: "15000",
  }),
  envelope({
    id: ALEX_IDS.envelopeInvesting,
    name: "Investing",
    priority: 50,
    priorityClass: "investing",
    targetMinor: "27500",
    fundedMinor: "27500",
  }),
  envelope({
    id: ALEX_IDS.envelopeFun,
    categoryId: ALEX_IDS.categoryDining,
    name: "Fun & Dining",
    priority: 10,
    priorityClass: "flexible",
    targetMinor: "12500",
    fundedMinor: "12500",
    activityMinor: "3925",
  }),
]);

function goal(input: {
  id: string;
  name: string;
  type: Goal["type"];
  priority: number;
  currentMinor: string;
  targetMinor: string;
  monthlyMinor: string;
  targetDate: string;
  linkedAccountIds: readonly string[];
  bufferPolicy?: Goal["bufferPolicy"];
}): Goal {
  return GoalSchema.parse({
    id: input.id,
    householdId: ALEX_IDS.household,
    name: input.name,
    type: input.type,
    priority: input.priority,
    currentAmount: { minorUnits: input.currentMinor, currency: "USD" },
    targetAmount: { minorUnits: input.targetMinor, currency: "USD" },
    targetDate: input.targetDate,
    monthlyContribution: { minorUnits: input.monthlyMinor, currency: "USD" },
    status: "active",
    linkedAccountIds: input.linkedAccountIds,
    bufferPolicy: input.bufferPolicy ?? "none",
    customBuffer: null,
    createdAt,
    updatedAt: createdAt,
  });
}

export const alexGoals: readonly Goal[] = Object.freeze([
  goal({
    id: ALEX_IDS.goalEmergency,
    name: "Six-month emergency fund",
    type: "emergencyFund",
    priority: 100,
    currentMinor: "725000",
    targetMinor: "1200000",
    monthlyMinor: "30000",
    targetDate: "2027-12-31",
    linkedAccountIds: [ALEX_IDS.savings],
    bufferPolicy: "emergencyFloor",
  }),
  goal({
    id: ALEX_IDS.goalDebtFree,
    name: "Student debt free",
    type: "debtFree",
    priority: 90,
    currentMinor: "0",
    targetMinor: "1460000",
    monthlyMinor: "55000",
    targetDate: "2028-12-31",
    linkedAccountIds: [ALEX_IDS.studentLoan],
  }),
  goal({
    id: ALEX_IDS.goalCar,
    name: "Reliable used car",
    type: "purchase",
    priority: 60,
    currentMinor: "150000",
    targetMinor: "1800000",
    monthlyMinor: "45000",
    targetDate: "2029-12-31",
    linkedAccountIds: [ALEX_IDS.savings],
    bufferPolicy: "emergencyFloor",
  }),
  goal({
    id: ALEX_IDS.goalAge30,
    name: "Age-30 financial strength",
    type: "netWorth",
    priority: 50,
    currentMinor: "907984",
    targetMinor: "15000000",
    monthlyMinor: "85000",
    targetDate: "2034-08-31",
    linkedAccountIds: [ALEX_IDS.savings, ALEX_IDS.brokerage, ALEX_IDS.retirement],
  }),
]);

export const alexSafeToSpend = calculateSafeToSpend({
  availableCash: money(385_025n, "USD"),
  reservedBills: money(145_000n, "USD"),
  envelopeCommitments: money(50_000n, "USD"),
  goalContributions: money(30_000n, "USD"),
  minimumBuffer: money(100_000n, "USD"),
});

export const alexBaseForecastScenario: ForecastScenario = Object.freeze<ForecastScenario>({
  id: "alex-base-age-22-to-30",
  name: "Alex base path",
  startMonth: "2026-08",
  horizonMonths: 96,
  baseCurrency: "USD",
  primaryCashAccountId: "checking",
  minimumCashBuffer: money(100_000n, "USD"),
  accounts: Object.freeze([
    {
      id: "checking",
      name: "Everyday Checking",
      type: "checking",
      balance: money(385_025n, "USD"),
      liquid: true,
      annualReturnBps: 0,
    },
    {
      id: "emergency",
      name: "Emergency Savings",
      type: "savings",
      balance: money(725_000n, "USD"),
      liquid: true,
      annualReturnBps: 350,
      assetClass: "cash",
    },
    {
      id: "brokerage",
      name: "Taxable Brokerage",
      type: "investment",
      balance: money(340_000n, "USD"),
      liquid: false,
      annualReturnBps: 700,
      assetClass: "stocks",
    },
    {
      id: "retirement",
      name: "401(k)",
      type: "retirement",
      balance: money(980_000n, "USD"),
      liquid: false,
      annualReturnBps: 700,
      assetClass: "stocks",
    },
  ]),
  cashFlows: Object.freeze([
    {
      id: "salary",
      name: "Salary",
      kind: "income",
      amount: money(520_000n, "USD"),
      annualGrowthBps: 300,
    },
    {
      id: "rent",
      name: "Rent",
      kind: "bill",
      amount: money(145_000n, "USD"),
      annualGrowthBps: 300,
      required: true,
    },
    {
      id: "utilities",
      name: "Utilities",
      kind: "bill",
      amount: money(20_000n, "USD"),
      annualGrowthBps: 250,
      required: true,
    },
    {
      id: "insurance",
      name: "Insurance",
      kind: "bill",
      amount: money(25_000n, "USD"),
      annualGrowthBps: 250,
      required: true,
    },
    {
      id: "living",
      name: "Living envelopes",
      kind: "envelope",
      amount: money(157_000n, "USD"),
      annualGrowthBps: 250,
      required: true,
    },
  ]),
  debts: Object.freeze([
    {
      id: "student-loan",
      name: "Federal student loan",
      principal: money(1_460_000n, "USD"),
      annualInterestBps: 475,
      minimumPayment: money(30_000n, "USD"),
      extraPayment: money(25_000n, "USD"),
    },
  ]),
  contributions: Object.freeze([
    {
      id: "emergency-goal",
      name: "Emergency fund",
      kind: "goal",
      amount: money(30_000n, "USD"),
      toAccountId: "emergency",
      targetAmount: money(1_200_000n, "USD"),
      priority: 100,
      required: true,
    },
    {
      id: "brokerage-investing",
      name: "Brokerage investing",
      kind: "investment",
      amount: money(35_000n, "USD"),
      toAccountId: "brokerage",
      priority: 50,
    },
    {
      id: "retirement-investing",
      name: "401(k) investing",
      kind: "investment",
      amount: money(50_000n, "USD"),
      toAccountId: "retirement",
      priority: 60,
    },
  ]),
});

function scenarioWith(
  id: string,
  name: string,
  changes: {
    incomeGrowthBps: number;
    stockReturnBps: number;
    livingMinor: bigint;
  },
): ForecastScenario {
  return Object.freeze({
    ...alexBaseForecastScenario,
    id,
    name,
    accounts: Object.freeze(
      alexBaseForecastScenario.accounts.map((account) =>
        account.assetClass === "stocks"
          ? { ...account, annualReturnBps: changes.stockReturnBps }
          : account,
      ),
    ),
    cashFlows: Object.freeze(
      alexBaseForecastScenario.cashFlows.map((flow) =>
        flow.id === "salary"
          ? { ...flow, annualGrowthBps: changes.incomeGrowthBps }
          : flow.id === "living"
            ? { ...flow, amount: money(changes.livingMinor, "USD") }
            : flow,
      ),
    ),
  });
}

export const alexForecastScenarios: readonly ForecastScenario[] = Object.freeze([
  alexBaseForecastScenario,
  scenarioWith("alex-conservative-age-22-to-30", "Alex conservative path", {
    incomeGrowthBps: 100,
    stockReturnBps: 400,
    livingMinor: 175_000n,
  }),
  scenarioWith("alex-accelerated-age-22-to-30", "Alex accelerated path", {
    incomeGrowthBps: 500,
    stockReturnBps: 850,
    livingMinor: 145_000n,
  }),
]);

export const alexMonteCarloInput: MonteCarloInput = Object.freeze({
  scenario: alexBaseForecastScenario,
  seed: "alex-age-22-to-30-v1",
  runs: 1_000,
  assumptions: Object.freeze([
    { assetClass: "cash", meanAnnualReturnBps: 350, annualVolatilityBps: 100 },
    { assetClass: "stocks", meanAnnualReturnBps: 700, annualVolatilityBps: 1_800 },
  ]),
  correlationMatrix: Object.freeze([Object.freeze([1, 0.1]), Object.freeze([0.1, 1])]),
  successTarget: money(15_000_000n, "USD"),
  successMonth: "2034-08",
});

export const alexFixture = Object.freeze({
  profile: Object.freeze({
    name: "Alex Rivera",
    birthDate: "2004-08-15",
    startingAge: 22,
    targetAge: 30,
    startMonth: "2026-08",
    targetMonth: "2034-08",
    timezone: "America/New_York",
    baseCurrency: "USD",
  }),
  ids: ALEX_IDS,
  accounts: alexAccounts,
  transactions: alexTransactions,
  envelopes: alexEnvelopes,
  goals: alexGoals,
  scenarios: alexForecastScenarios,
  monteCarlo: alexMonteCarloInput,
  expected: Object.freeze({
    safeToSpend: moneyToJson(alexSafeToSpend.safeToSpend),
    startingNetWorth: { minorUnits: "906984", currency: "USD" },
    transferNet: { minorUnits: "0", currency: "USD" },
    forecastMonths: 96,
    emergencyFundMonth: "2027-11",
    comfortablePurchaseFundingMonth: "2029-09",
    debtFreeMonth: "2029-01",
    age30Month: "2034-08",
    age30NetWorth: { minorUnits: "23874435", currency: "USD" },
  }),
});

export type AlexFixture = typeof alexFixture;
