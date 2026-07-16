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

export interface Envelope {
  name: string;
  icon: string;
  planned: number;
  funded: number;
  activity: number;
  available: number;
  cadence: string;
  pacing: "on-track" | "watch" | "over";
  due?: string;
}

export interface GoalItem {
  id: string;
  name: string;
  type: string;
  funded: number;
  target: number;
  monthly: number;
  safeDate: string;
  probability: number;
  impact: number;
  accent: string;
}

export interface AccountItem {
  id: string;
  name: string;
  institution: string;
  type: string;
  group: string;
  mask: string;
  balance: number;
  change: number;
  status: "Healthy" | "Manual" | "Attention";
  updated: string;
}

export const netWorthHistory = [
  { month: "Aug", total: 8900, liquid: 7200 },
  { month: "Sep", total: 9700, liquid: 7850 },
  { month: "Oct", total: 10800, liquid: 8600 },
  { month: "Nov", total: 11650, liquid: 9320 },
  { month: "Dec", total: 12800, liquid: 10100 },
  { month: "Jan", total: 13750, liquid: 10980 },
  { month: "Feb", total: 14600, liquid: 11830 },
  { month: "Mar", total: 15750, liquid: 12710 },
  { month: "Apr", total: 16900, liquid: 13680 },
  { month: "May", total: 17850, liquid: 14520 },
  { month: "Jun", total: 18700, liquid: 15340 },
  { month: "Jul", total: 19800, liquid: 16300 },
];

export const forecastHistory = [
  { age: 22, conservative: 16300, baseline: 16300, ambitious: 16300 },
  { age: 23, conservative: 28600, baseline: 30600, ambitious: 32900 },
  { age: 24, conservative: 42300, baseline: 47600, ambitious: 53700 },
  { age: 25, conservative: 57700, baseline: 67600, ambitious: 79400 },
  { age: 26, conservative: 74800, baseline: 90400, ambitious: 110200 },
  { age: 27, conservative: 93800, baseline: 116800, ambitious: 146400 },
  { age: 28, conservative: 114900, baseline: 147300, ambitious: 189900 },
  { age: 29, conservative: 138200, baseline: 182500, ambitious: 240100 },
  { age: 30, conservative: 164000, baseline: 223400, ambitious: 298300 },
];

export const transactions: LedgerItem[] = [
  {
    id: "txn_01",
    date: "Today",
    merchant: "Whole Foods Market",
    rawDescription: "WHOLEFDS MKT 10264",
    account: "Everyday checking",
    accountMask: "2401",
    category: "Groceries",
    envelope: "Groceries",
    amount: -86.42,
    confidence: 0.98,
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
    amount: 2200,
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
    amount: -48.16,
    pending: true,
    needsReview: true,
    confidence: 0.72,
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
    amount: -94.22,
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
    amount: -300,
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
    amount: 300,
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
    amount: -16.99,
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
    amount: -42.08,
    confidence: 0.96,
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
    amount: -118.74,
    needsReview: true,
    confidence: 0.61,
    provenance: "CSV import · New merchant",
  },
];

export const envelopes: Envelope[] = [
  {
    name: "Rent",
    icon: "home",
    planned: 1400,
    funded: 1400,
    activity: -1400,
    available: 0,
    cadence: "Monthly",
    pacing: "on-track",
    due: "Paid Jul 1",
  },
  {
    name: "Groceries",
    icon: "cart",
    planned: 420,
    funded: 420,
    activity: -238.42,
    available: 181.58,
    cadence: "Monthly",
    pacing: "on-track",
  },
  {
    name: "Dining out",
    icon: "dining",
    planned: 180,
    funded: 180,
    activity: -164.16,
    available: 15.84,
    cadence: "Monthly",
    pacing: "watch",
  },
  {
    name: "Utilities",
    icon: "bolt",
    planned: 210,
    funded: 210,
    activity: -94.22,
    available: 115.78,
    cadence: "Monthly",
    pacing: "on-track",
    due: "Internet Jul 21",
  },
  {
    name: "Transportation",
    icon: "car",
    planned: 260,
    funded: 260,
    activity: -126.08,
    available: 133.92,
    cadence: "Monthly",
    pacing: "on-track",
  },
  {
    name: "Fun money",
    icon: "spark",
    planned: 160,
    funded: 160,
    activity: -176.99,
    available: -16.99,
    cadence: "Monthly",
    pacing: "over",
  },
];

export const goals: GoalItem[] = [
  {
    id: "goal_01",
    name: "Emergency fund",
    type: "Cash resilience",
    funded: 4500,
    target: 12000,
    monthly: 650,
    safeDate: "July 2027",
    probability: 0.88,
    impact: 0,
    accent: "#1F9D72",
  },
  {
    id: "goal_02",
    name: "Lisbon trip",
    type: "Comfortable purchase",
    funded: 1260,
    target: 3000,
    monthly: 290,
    safeDate: "February 2027",
    probability: 0.84,
    impact: -4100,
    accent: "#4A7FD1",
  },
  {
    id: "goal_03",
    name: "Student loan freedom",
    type: "Debt payoff",
    funded: 2400,
    target: 12000,
    monthly: 390,
    safeDate: "October 2028",
    probability: 0.91,
    impact: 6800,
    accent: "#8B6CCF",
  },
  {
    id: "goal_04",
    name: "$100k invested",
    type: "Investment milestone",
    funded: 14500,
    target: 100000,
    monthly: 700,
    safeDate: "May 2032",
    probability: 0.73,
    impact: 18400,
    accent: "#D98B2B",
  },
];

export const accounts: AccountItem[] = [
  {
    id: "acc_01",
    name: "Everyday checking",
    institution: "Northstar Bank",
    type: "Checking",
    group: "Cash",
    mask: "2401",
    balance: 3000,
    change: 4.2,
    status: "Healthy",
    updated: "2 min ago",
  },
  {
    id: "acc_02",
    name: "High-yield savings",
    institution: "Northstar Bank",
    type: "Savings",
    group: "Cash",
    mask: "6118",
    balance: 4500,
    change: 9.8,
    status: "Healthy",
    updated: "2 min ago",
  },
  {
    id: "acc_03",
    name: "Taxable brokerage",
    institution: "Vanguard",
    type: "Brokerage",
    group: "Investments",
    mask: "7730",
    balance: 6500,
    change: 12.6,
    status: "Healthy",
    updated: "8 min ago",
  },
  {
    id: "acc_04",
    name: "401(k)",
    institution: "Fidelity",
    type: "Retirement",
    group: "Investments",
    mask: "4022",
    balance: 8000,
    change: 14.1,
    status: "Healthy",
    updated: "Yesterday",
  },
  {
    id: "acc_05",
    name: "Emerald card",
    institution: "Northstar Bank",
    type: "Credit card",
    group: "Credit",
    mask: "8802",
    balance: -1200,
    change: -2.4,
    status: "Healthy",
    updated: "2 min ago",
  },
  {
    id: "acc_06",
    name: "Student loan",
    institution: "Federal Student Aid",
    type: "Loan · 5.4% APR",
    group: "Loans",
    mask: "1095",
    balance: -12000,
    change: 6.1,
    status: "Manual",
    updated: "Jul 1",
  },
];

export const recentActivity = transactions.slice(0, 5);

export const rules = [
  {
    id: "rule_01",
    name: "Whole Foods groceries",
    summary: "When merchant is Whole Foods → set Groceries and fund from Groceries",
    priority: 10,
    matches: 18,
    last: "Today",
    source: "You",
    enabled: true,
  },
  {
    id: "rule_02",
    name: "Payroll income",
    summary: "When description contains PAYROLL and amount is an inflow → mark as Income",
    priority: 20,
    matches: 12,
    last: "Today",
    source: "System",
    enabled: true,
  },
  {
    id: "rule_03",
    name: "Metro fuel",
    summary: "When merchant starts with Metro Fuel → set Transportation",
    priority: 30,
    matches: 9,
    last: "Jul 11",
    source: "Approved AI",
    enabled: true,
  },
  {
    id: "rule_04",
    name: "Vanguard transfers",
    summary: "When merchant is Vanguard and account is Checking → request transfer match",
    priority: 40,
    matches: 7,
    last: "Jul 13",
    source: "You",
    enabled: true,
  },
];
