/**
 * The web demo universe: the fictional household rendered when demo mode is on
 * (the `bw-demo` session flag). Every money amount is stored as an exact base-10
 * minor-unit string — the same transport shape the real API uses — never as a
 * float, so the demo cannot drift into cent-rounding artifacts.
 *
 * This module is the ONLY web-side fixture source, and demoApi.ts is the ONLY
 * projection of it into API-shaped responses; pages must not fabricate their own
 * API responses. The values are pinned by the demo-mode tests in src/test. They
 * deliberately mirror the spirit of the canonical API seed fixture
 * (packages/testkit/src/alex.ts) but cannot import it: apps/web depends only on
 * @betterwealth/shared, and @betterwealth/testkit is not in its dependency graph
 * (see docs/AUDIT.md, "Clean workspace dependency direction").
 */

/**
 * Ledger row view model. `amount` is a display-only number (rows and charts are
 * inherently approximate); the exact value always travels as `amountMinorUnits`.
 */
export interface LedgerItem {
  id: string;
  date: string;
  merchant: string;
  rawDescription: string;
  account: string;
  accountMask: string;
  category: string;
  envelope: string;
  amount: number;
  pending?: boolean;
  needsReview?: boolean;
  recurring?: boolean;
  excluded?: boolean;
  note?: string;
  confidence?: number;
  provenance: string;
}

/**
 * Canonical demo ledger record: the ledger view metadata with the float `amount`
 * replaced by an exact minor-unit string and an explicit currency.
 */
export interface DemoTransaction extends Omit<LedgerItem, "amount"> {
  amountMinorUnits: string;
  currency: string;
}

export const transactions: DemoTransaction[] = [
  {
    id: "txn_01",
    date: "Today",
    merchant: "Whole Foods Market",
    rawDescription: "WHOLEFDS MKT 10264",
    account: "Everyday checking",
    accountMask: "2401",
    category: "Groceries",
    envelope: "Groceries",
    amountMinorUnits: "-8642",
    currency: "USD",
    provenance: "SimpleFIN · Rule: Whole Foods → Groceries",
  },
  {
    id: "txn_02",
    date: "Today",
    merchant: "Acme Payroll",
    rawDescription: "ACME INC PAYROLL DD",
    account: "Everyday checking",
    accountMask: "2401",
    category: "Income",
    envelope: "Unassigned",
    amountMinorUnits: "220000",
    currency: "USD",
    provenance: "SimpleFIN · Income pattern detected",
  },
  {
    id: "txn_03",
    date: "Yesterday",
    merchant: "Corner Table",
    rawDescription: "TST* CORNER TABLE",
    account: "Emerald card",
    accountMask: "8802",
    category: "Dining",
    envelope: "Dining out",
    amountMinorUnits: "-4816",
    currency: "USD",
    pending: true,
    needsReview: true,
    provenance: "SimpleFIN · AI suggestion, not yet approved",
  },
  {
    id: "txn_04",
    date: "Yesterday",
    merchant: "City Electric",
    rawDescription: "CITY ELEC AUTOPAY",
    account: "Everyday checking",
    accountMask: "2401",
    category: "Utilities",
    envelope: "Utilities",
    amountMinorUnits: "-9422",
    currency: "USD",
    recurring: true,
    provenance: "SimpleFIN · Recurring bill series",
  },
  {
    id: "txn_05",
    date: "Mon, Jul 13",
    merchant: "Vanguard",
    rawDescription: "VANGUARD BROKERAGE ACH",
    account: "Everyday checking",
    accountMask: "2401",
    category: "Transfer",
    envelope: "Investing",
    amountMinorUnits: "-30000",
    currency: "USD",
    excluded: true,
    provenance: "SimpleFIN · Matched transfer to Brokerage",
  },
  {
    id: "txn_06",
    date: "Mon, Jul 13",
    merchant: "Vanguard",
    rawDescription: "ACH CREDIT FROM CHECKING",
    account: "Taxable brokerage",
    accountMask: "7730",
    category: "Transfer",
    envelope: "Investing",
    amountMinorUnits: "30000",
    currency: "USD",
    excluded: true,
    provenance: "SimpleFIN · Matched transfer from Checking",
  },
  {
    id: "txn_07",
    date: "Sun, Jul 12",
    merchant: "Streambox",
    rawDescription: "STREAMBOX.COM",
    account: "Emerald card",
    accountMask: "8802",
    category: "Entertainment",
    envelope: "Subscriptions",
    amountMinorUnits: "-1699",
    currency: "USD",
    recurring: true,
    provenance: "SimpleFIN · Merchant history",
  },
  {
    id: "txn_08",
    date: "Sat, Jul 11",
    merchant: "Metro Fuel",
    rawDescription: "METRO FUEL 044",
    account: "Emerald card",
    accountMask: "8802",
    category: "Transportation",
    envelope: "Transportation",
    amountMinorUnits: "-4208",
    currency: "USD",
    provenance: "SimpleFIN · Rule: Metro Fuel",
  },
  {
    id: "txn_09",
    date: "Fri, Jul 10",
    merchant: "Home Supply",
    rawDescription: "HOME SUPPLY #108",
    account: "Emerald card",
    accountMask: "8802",
    category: "Shopping",
    envelope: "Home",
    amountMinorUnits: "-11874",
    currency: "USD",
    needsReview: true,
    provenance: "CSV import · New merchant",
  },
];

export interface DemoEnvelope {
  name: string;
  plannedMinorUnits: string;
  fundedMinorUnits: string;
  /** Signed activity for the period; negative means spent. */
  activityMinorUnits: string;
  availableMinorUnits: string;
  cadence: string;
  pacing: "on-track" | "watch" | "over";
}

export const envelopes: DemoEnvelope[] = [
  {
    name: "Rent",
    plannedMinorUnits: "140000",
    fundedMinorUnits: "140000",
    activityMinorUnits: "-140000",
    availableMinorUnits: "0",
    cadence: "Monthly",
    pacing: "on-track",
  },
  {
    name: "Groceries",
    plannedMinorUnits: "42000",
    fundedMinorUnits: "42000",
    activityMinorUnits: "-23842",
    availableMinorUnits: "18158",
    cadence: "Monthly",
    pacing: "on-track",
  },
  {
    name: "Dining out",
    plannedMinorUnits: "18000",
    fundedMinorUnits: "18000",
    activityMinorUnits: "-16416",
    availableMinorUnits: "1584",
    cadence: "Monthly",
    pacing: "watch",
  },
  {
    name: "Utilities",
    plannedMinorUnits: "21000",
    fundedMinorUnits: "21000",
    activityMinorUnits: "-9422",
    availableMinorUnits: "11578",
    cadence: "Monthly",
    pacing: "on-track",
  },
  {
    name: "Transportation",
    plannedMinorUnits: "26000",
    fundedMinorUnits: "26000",
    activityMinorUnits: "-12608",
    availableMinorUnits: "13392",
    cadence: "Monthly",
    pacing: "on-track",
  },
  {
    name: "Fun money",
    plannedMinorUnits: "16000",
    fundedMinorUnits: "16000",
    activityMinorUnits: "-17699",
    availableMinorUnits: "-1699",
    cadence: "Monthly",
    pacing: "over",
  },
];

export interface DemoGoal {
  id: string;
  name: string;
  type: "emergency_fund" | "purchase" | "debt_payoff" | "investment";
  fundedMinorUnits: string;
  targetMinorUnits: string;
  monthlyMinorUnits: string;
  targetDate: string;
  /** Display label for the modeled safe date on the Today card. */
  earliestSafeDate: string;
  /** Modeled funding likelihood shown on the Today card, 0..1. */
  probability: number;
}

export const goals: DemoGoal[] = [
  {
    id: "goal_01",
    name: "Emergency fund",
    type: "emergency_fund",
    fundedMinorUnits: "450000",
    targetMinorUnits: "1200000",
    monthlyMinorUnits: "65000",
    targetDate: "2027-07-01",
    earliestSafeDate: "July 2027",
    probability: 0.88,
  },
  {
    id: "goal_02",
    name: "Lisbon trip",
    type: "purchase",
    fundedMinorUnits: "126000",
    targetMinorUnits: "300000",
    monthlyMinorUnits: "29000",
    targetDate: "2027-02-01",
    earliestSafeDate: "February 2027",
    probability: 0.84,
  },
  {
    id: "goal_03",
    name: "Student loan freedom",
    type: "debt_payoff",
    fundedMinorUnits: "240000",
    targetMinorUnits: "1200000",
    monthlyMinorUnits: "39000",
    targetDate: "2028-10-01",
    earliestSafeDate: "October 2028",
    probability: 0.91,
  },
  {
    id: "goal_04",
    name: "$100k invested",
    type: "investment",
    fundedMinorUnits: "1450000",
    targetMinorUnits: "10000000",
    monthlyMinorUnits: "70000",
    targetDate: "2032-05-01",
    earliestSafeDate: "May 2032",
    probability: 0.73,
  },
];

export interface DemoAccount {
  id: string;
  name: string;
  institution: string;
  type: string;
  group: "Cash" | "Investments" | "Credit" | "Loans";
  mask: string;
  balanceMinorUnits: string;
  status: "Healthy" | "Manual" | "Attention";
  updatedLabel: string;
}

export const accounts: DemoAccount[] = [
  {
    id: "acc_01",
    name: "Everyday checking",
    institution: "Northstar Bank",
    type: "Checking",
    group: "Cash",
    mask: "2401",
    balanceMinorUnits: "300000",
    status: "Healthy",
    updatedLabel: "2 min ago",
  },
  {
    id: "acc_02",
    name: "High-yield savings",
    institution: "Northstar Bank",
    type: "Savings",
    group: "Cash",
    mask: "6118",
    balanceMinorUnits: "450000",
    status: "Healthy",
    updatedLabel: "2 min ago",
  },
  {
    id: "acc_03",
    name: "Taxable brokerage",
    institution: "Vanguard",
    type: "Brokerage",
    group: "Investments",
    mask: "7730",
    balanceMinorUnits: "650000",
    status: "Healthy",
    updatedLabel: "8 min ago",
  },
  {
    id: "acc_04",
    name: "401(k)",
    institution: "Fidelity",
    type: "Retirement",
    group: "Investments",
    mask: "4022",
    balanceMinorUnits: "800000",
    status: "Healthy",
    updatedLabel: "Yesterday",
  },
  {
    id: "acc_05",
    name: "Emerald card",
    institution: "Northstar Bank",
    type: "Credit card",
    group: "Credit",
    mask: "8802",
    balanceMinorUnits: "-120000",
    status: "Healthy",
    updatedLabel: "2 min ago",
  },
  {
    id: "acc_06",
    name: "Student loan",
    institution: "Federal Student Aid",
    type: "Loan · 5.4% APR",
    group: "Loans",
    mask: "1095",
    balanceMinorUnits: "-1200000",
    status: "Manual",
    updatedLabel: "Jul 1",
  },
];

export interface DemoRule {
  id: string;
  name: string;
  priority: number;
  matches: number;
  last: string;
  source: "You" | "System" | "Approved AI";
  enabled: boolean;
}

export const rules: DemoRule[] = [
  {
    id: "rule_01",
    name: "Whole Foods groceries",
    priority: 10,
    matches: 18,
    last: "Today",
    source: "You",
    enabled: true,
  },
  {
    id: "rule_02",
    name: "Payroll income",
    priority: 20,
    matches: 12,
    last: "Today",
    source: "System",
    enabled: true,
  },
  {
    id: "rule_03",
    name: "Metro fuel",
    priority: 30,
    matches: 9,
    last: "Jul 11",
    source: "Approved AI",
    enabled: true,
  },
  {
    id: "rule_04",
    name: "Vanguard transfers",
    priority: 40,
    matches: 7,
    last: "Jul 13",
    source: "You",
    enabled: true,
  },
];

export interface DemoSuggestion {
  id: string;
  merchant: string;
  raw: string;
  category: string;
  /** Confidence in percent, 0..100. */
  confidence: number;
  amountMinorUnits: string;
  rationale: string;
}

export const suggestions: DemoSuggestion[] = [
  {
    id: "ai_01",
    merchant: "Corner Table",
    raw: "TST* CORNER TABLE",
    category: "Dining",
    confidence: 72,
    amountMinorUnits: "-4816",
    rationale: "Similar local restaurant merchants were categorized as Dining.",
  },
  {
    id: "ai_02",
    merchant: "Home Supply",
    raw: "HOME SUPPLY #108",
    category: "Home",
    confidence: 61,
    amountMinorUnits: "-11874",
    rationale: "The merchant suggests household supplies, but local history is still limited.",
  },
];

export interface DemoNetWorthPoint {
  month: string;
  totalMinorUnits: string;
  liquidMinorUnits: string;
}

export const netWorthHistory: DemoNetWorthPoint[] = [
  { month: "Aug", totalMinorUnits: "890000", liquidMinorUnits: "720000" },
  { month: "Sep", totalMinorUnits: "970000", liquidMinorUnits: "785000" },
  { month: "Oct", totalMinorUnits: "1080000", liquidMinorUnits: "860000" },
  { month: "Nov", totalMinorUnits: "1165000", liquidMinorUnits: "932000" },
  { month: "Dec", totalMinorUnits: "1280000", liquidMinorUnits: "1010000" },
  { month: "Jan", totalMinorUnits: "1375000", liquidMinorUnits: "1098000" },
  { month: "Feb", totalMinorUnits: "1460000", liquidMinorUnits: "1183000" },
  { month: "Mar", totalMinorUnits: "1575000", liquidMinorUnits: "1271000" },
  { month: "Apr", totalMinorUnits: "1690000", liquidMinorUnits: "1368000" },
  { month: "May", totalMinorUnits: "1785000", liquidMinorUnits: "1452000" },
  { month: "Jun", totalMinorUnits: "1870000", liquidMinorUnits: "1534000" },
  { month: "Jul", totalMinorUnits: "1980000", liquidMinorUnits: "1630000" },
];

export interface DemoForecastPoint {
  age: number;
  conservative: string;
  baseline: string;
  ambitious: string;
}

export const forecastHistory: DemoForecastPoint[] = [
  { age: 22, conservative: "1630000", baseline: "1630000", ambitious: "1630000" },
  { age: 23, conservative: "2860000", baseline: "3060000", ambitious: "3290000" },
  { age: 24, conservative: "4230000", baseline: "4760000", ambitious: "5370000" },
  { age: 25, conservative: "5770000", baseline: "6760000", ambitious: "7940000" },
  { age: 26, conservative: "7480000", baseline: "9040000", ambitious: "11020000" },
  { age: 27, conservative: "9380000", baseline: "11680000", ambitious: "14640000" },
  { age: 28, conservative: "11490000", baseline: "14730000", ambitious: "18990000" },
  { age: 29, conservative: "13820000", baseline: "18250000", ambitious: "24010000" },
  { age: 30, conservative: "16400000", baseline: "22340000", ambitious: "29830000" },
];
