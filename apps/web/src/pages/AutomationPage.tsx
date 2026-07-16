import {
  AddRounded,
  AutoAwesomeRounded,
  CheckCircleRounded,
  CloseRounded,
  DeleteOutlineRounded,
  EditRounded,
  PlayArrowRounded,
  RuleRounded,
  SearchRounded,
  ShieldRounded,
  SmartToyRounded,
  TuneRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import {
  Alert,
  alpha,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Paper,
  Select,
  Tab,
  Tabs,
  Tooltip,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  type ApiAccount,
  type ApiAiSuggestion,
  type ApiCategory,
  type ApiEnvelope,
  type ApiRule,
  type ApiRulePreview,
  type ApiRuleWriteInput,
  type ApiTransaction,
  api,
  type CursorPage,
} from "../api";
import { Drawer, Stack, Switch, TextField, Typography } from "../components/mui";
import { PlanFlowCard } from "../components/PlanFlowCard";
import {
  EmptyState,
  ErrorState,
  LoadingCard,
  Money,
  PageHeader,
  SectionHeader,
  StatusChip,
} from "../components/ui";
import {
  accounts as fixtureAccounts,
  envelopes as fixtureEnvelopes,
  rules as fixtureRules,
  transactions as fixtureTransactions,
} from "../data";
import { isDemoMode } from "../demo";

type ConditionField = "merchant" | "description" | "direction" | "amount" | "account" | "status";
type ActionField = "category" | "envelope" | "review" | "flag" | "merchant";

interface ConditionDraft {
  key: string;
  field: ConditionField;
  operator: string;
  value: string;
  minimum: string;
  maximum: string;
}

interface ActionDraft {
  key: string;
  field: ActionField;
  value: string;
  flag: "transfer" | "income" | "reimbursement" | "reportingExcluded";
  booleanValue: boolean;
}

interface BuilderDraft {
  name: string;
  priority: string;
  enabled: boolean;
  conditions: ConditionDraft[];
  actions: ActionDraft[];
  unsupported: boolean;
}

interface SuggestionView {
  id: string;
  merchant: string;
  raw: string;
  category: string;
  confidence: number;
  amount: number;
  rationale: string;
  proposal: string;
}

let draftSequence = 0;
function draftKey(prefix: string) {
  draftSequence += 1;
  return `${prefix}-${draftSequence}`;
}

function emptyCondition(field: ConditionField = "merchant"): ConditionDraft {
  return {
    key: draftKey("condition"),
    field,
    operator:
      field === "description" ? "contains" : field === "amount" ? "absoluteBetween" : "exact",
    value: field === "direction" ? "outflow" : field === "status" ? "posted" : "",
    minimum: "",
    maximum: "",
  };
}

function emptyAction(field: ActionField = "category"): ActionDraft {
  return {
    key: draftKey("action"),
    field,
    value: "",
    flag: "income",
    booleanValue: true,
  };
}

function emptyBuilderDraft(): BuilderDraft {
  return {
    name: "",
    priority: "500",
    enabled: true,
    conditions: [emptyCondition()],
    actions: [emptyAction()],
    unsupported: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function minorUnitsToInput(value: unknown) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return "";
  const amount = BigInt(value);
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${sign}${absolute / 100n}.${fraction}`;
}

function parseCondition(value: unknown): { draft?: ConditionDraft; unsupported: boolean } {
  const condition = asRecord(value);
  if (!condition || typeof condition.field !== "string") return { unsupported: true };
  const field = condition.field;
  if (
    field === "merchant" &&
    condition.operator === "exact" &&
    typeof condition.value === "string"
  ) {
    return {
      draft: { ...emptyCondition("merchant"), value: condition.value },
      unsupported: false,
    };
  }
  if (
    ["description", "rawDescription", "normalizedDescription"].includes(field) &&
    ["exact", "contains", "startsWith", "endsWith", "regex"].includes(String(condition.operator)) &&
    typeof condition.value === "string"
  ) {
    return {
      draft: {
        ...emptyCondition("description"),
        operator: String(condition.operator),
        value: condition.value,
      },
      unsupported: false,
    };
  }
  if (field === "direction" && typeof condition.value === "string") {
    return {
      draft: { ...emptyCondition("direction"), value: condition.value },
      unsupported: false,
    };
  }
  if (field === "amount" && ["exact", "absoluteBetween"].includes(String(condition.operator))) {
    return {
      draft: {
        ...emptyCondition("amount"),
        operator: String(condition.operator),
        value: minorUnitsToInput(condition.value),
        minimum: minorUnitsToInput(condition.minimum),
        maximum: minorUnitsToInput(condition.maximum),
      },
      unsupported: false,
    };
  }
  if (
    field === "accountId" &&
    condition.operator === "exact" &&
    typeof condition.value === "string"
  ) {
    return {
      draft: { ...emptyCondition("account"), value: condition.value },
      unsupported: false,
    };
  }
  if (field === "status" && condition.operator === "exact" && typeof condition.value === "string") {
    return {
      draft: { ...emptyCondition("status"), value: condition.value },
      unsupported: false,
    };
  }
  return { unsupported: true };
}

function parseAction(value: unknown): { draft?: ActionDraft; unsupported: boolean } {
  const action = asRecord(value);
  if (!action || typeof action.type !== "string") return { unsupported: true };
  if (action.type === "setCategory" && typeof action.categoryId === "string") {
    return {
      draft: { ...emptyAction("category"), value: action.categoryId },
      unsupported: false,
    };
  }
  if (action.type === "setEnvelope" && typeof action.envelopeId === "string") {
    return {
      draft: { ...emptyAction("envelope"), value: action.envelopeId },
      unsupported: false,
    };
  }
  if (action.type === "requestReview" && typeof action.value === "boolean") {
    return {
      draft: { ...emptyAction("review"), booleanValue: action.value },
      unsupported: false,
    };
  }
  if (
    action.type === "setFlag" &&
    ["transfer", "income", "reimbursement", "reportingExcluded"].includes(String(action.flag)) &&
    typeof action.value === "boolean"
  ) {
    return {
      draft: {
        ...emptyAction("flag"),
        flag: action.flag as ActionDraft["flag"],
        booleanValue: action.value,
      },
      unsupported: false,
    };
  }
  if (action.type === "normalizeMerchant" && typeof action.merchant === "string") {
    return {
      draft: { ...emptyAction("merchant"), value: action.merchant },
      unsupported: false,
    };
  }
  return { unsupported: true };
}

function ruleToBuilderDraft(rule: ApiRule): BuilderDraft {
  const root = asRecord(rule.conditions);
  const rawConditions = root && Array.isArray(root.all) ? root.all : [rule.conditions];
  const parsedConditions = rawConditions.map(parseCondition);
  const rawActions = Array.isArray(rule.actions) ? rule.actions : [];
  const parsedActions = rawActions.map(parseAction);
  const conditions = parsedConditions.flatMap((item) => (item.draft ? [item.draft] : []));
  const actions = parsedActions.flatMap((item) => (item.draft ? [item.draft] : []));
  return {
    name: rule.name,
    priority: String(rule.priority),
    enabled: rule.enabled,
    conditions: conditions.length ? conditions : [emptyCondition()],
    actions: actions.length ? actions : [emptyAction()],
    unsupported:
      Boolean(root && (Array.isArray(root.any) || root.not)) ||
      parsedConditions.some((item) => item.unsupported) ||
      parsedActions.some((item) => item.unsupported),
  };
}

function inputToMinorUnits(value: string, label: string) {
  const match = value.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match?.[2]) throw new Error(`${label} must be a dollar amount with at most two decimals.`);
  const minor = BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0") || "0");
  return `${match[1] === "-" ? "-" : ""}${minor}`;
}

function buildRuleInput(draft: BuilderDraft): ApiRuleWriteInput {
  const name = draft.name.trim();
  if (!name) throw new Error("Give the rule a name.");
  const priority = Number(draft.priority);
  if (!Number.isInteger(priority) || priority < -1_000_000 || priority > 1_000_000) {
    throw new Error("Priority must be a whole number between -1,000,000 and 1,000,000.");
  }
  if (!draft.conditions.length) throw new Error("Add at least one condition.");
  if (!draft.actions.length) throw new Error("Add at least one action.");

  const conditionNodes = draft.conditions.map((condition, index) => {
    const position = `Condition ${index + 1}`;
    if (condition.field === "merchant") {
      if (!condition.value.trim()) throw new Error(`${position} needs a merchant.`);
      return {
        field: "merchant",
        operator: "exact",
        value: condition.value.trim(),
        caseSensitive: false,
      };
    }
    if (condition.field === "description") {
      if (!condition.value.trim()) throw new Error(`${position} needs description text.`);
      return {
        field: "normalizedDescription",
        operator: condition.operator,
        value: condition.value.trim(),
        caseSensitive: false,
      };
    }
    if (condition.field === "direction") {
      return { field: "direction", operator: "exact", value: condition.value };
    }
    if (condition.field === "amount") {
      if (condition.operator === "exact") {
        return {
          field: "amount",
          operator: "exact",
          value: inputToMinorUnits(condition.value, `${position} amount`),
        };
      }
      const minimum = inputToMinorUnits(condition.minimum, `${position} minimum`);
      const maximum = inputToMinorUnits(condition.maximum, `${position} maximum`);
      if (BigInt(minimum) < 0n || BigInt(maximum) < BigInt(minimum)) {
        throw new Error(`${position} needs a non-negative range from low to high.`);
      }
      return { field: "amount", operator: "absoluteBetween", minimum, maximum };
    }
    if (condition.field === "account") {
      if (!condition.value) throw new Error(`${position} needs an account.`);
      return {
        field: "accountId",
        operator: "exact",
        value: condition.value,
        caseSensitive: false,
      };
    }
    return { field: "status", operator: "exact", value: condition.value };
  });

  const actionNodes = draft.actions.map((action, index) => {
    const position = `Action ${index + 1}`;
    if (action.field === "category") {
      if (!action.value) throw new Error(`${position} needs a category.`);
      return { type: "setCategory", categoryId: action.value };
    }
    if (action.field === "envelope") {
      if (!action.value) throw new Error(`${position} needs a budget envelope.`);
      return { type: "setEnvelope", envelopeId: action.value };
    }
    if (action.field === "review") return { type: "requestReview", value: action.booleanValue };
    if (action.field === "flag") {
      return { type: "setFlag", flag: action.flag, value: action.booleanValue };
    }
    if (!action.value.trim()) throw new Error(`${position} needs a normalized merchant name.`);
    return { type: "normalizeMerchant", merchant: action.value.trim() };
  });

  const duplicateActions = new Set<string>();
  for (const action of actionNodes) {
    const record = action as Record<string, unknown>;
    const key = `${record.type}:${record.flag ?? ""}`;
    if (duplicateActions.has(key)) throw new Error("Remove duplicate actions before previewing.");
    duplicateActions.add(key);
  }

  return {
    name,
    priority,
    enabled: draft.enabled,
    origin: "user",
    conditions: conditionNodes.length === 1 ? conditionNodes[0] : { all: conditionNodes },
    actions: actionNodes,
  };
}

function humanizeFlag(value: string) {
  return value === "reportingExcluded"
    ? "excluded from reports"
    : value === "reimbursement"
      ? "reimbursement"
      : value;
}

function describeCondition(value: unknown, accounts: ApiAccount[]): string {
  const condition = asRecord(value);
  if (!condition) return "Advanced condition";
  if (Array.isArray(condition.all)) {
    return condition.all.map((child) => describeCondition(child, accounts)).join(" and ");
  }
  if (Array.isArray(condition.any)) {
    return `Any of: ${condition.any.map((child) => describeCondition(child, accounts)).join("; ")}`;
  }
  if (condition.not) return `Not ${describeCondition(condition.not, accounts)}`;
  if (condition.field === "merchant") return `Merchant is “${String(condition.value)}”`;
  if (
    ["description", "rawDescription", "normalizedDescription"].includes(String(condition.field))
  ) {
    return `Description ${String(condition.operator)} “${String(condition.value)}”`;
  }
  if (condition.field === "direction") return `Direction is ${String(condition.value)}`;
  if (condition.field === "status") return `Status is ${String(condition.value)}`;
  if (condition.field === "accountId") {
    return `Account is ${accounts.find((account) => account.id === condition.value)?.name ?? "selected account"}`;
  }
  if (condition.field === "amount") {
    if (condition.operator === "exact") return `Amount is ${minorUnitsToInput(condition.value)}`;
    return `Absolute amount is ${minorUnitsToInput(condition.minimum)}–${minorUnitsToInput(condition.maximum)}`;
  }
  return "Advanced condition";
}

function describeActions(value: unknown, categories: ApiCategory[], envelopes: ApiEnvelope[]) {
  if (!Array.isArray(value)) return "advanced action";
  return value
    .map((raw) => {
      const action = asRecord(raw);
      if (!action) return "advanced action";
      if (action.type === "setCategory") {
        return `categorize as ${categories.find((category) => category.id === action.categoryId)?.name ?? "selected category"}`;
      }
      if (action.type === "setEnvelope") {
        return `attach ${envelopes.find((envelope) => envelope.id === action.envelopeId)?.name ?? "selected envelope"}`;
      }
      if (action.type === "requestReview") return action.value ? "request review" : "clear review";
      if (action.type === "setFlag") {
        return `${action.value ? "mark" : "unmark"} ${humanizeFlag(String(action.flag))}`;
      }
      if (action.type === "normalizeMerchant") return `name merchant “${String(action.merchant)}”`;
      return "advanced action";
    })
    .join(" and ");
}

function formatLastMatched(value?: string) {
  if (!value) return "Never matched";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return `Last matched ${value}`;
  return `Last matched ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: parsed.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(parsed)}`;
}

const demoCategories: CursorPage<ApiCategory> = {
  data: (
    [
      ["category-groceries", "Groceries", "expense"],
      ["category-dining", "Dining", "expense"],
      ["category-utilities", "Utilities", "expense"],
      ["category-transportation", "Transportation", "expense"],
      ["category-income", "Income", "income"],
      ["category-transfer", "Transfer", "transfer"],
    ] satisfies Array<[string, string, ApiCategory["kind"]]>
  ).map(([id, name, kind]) => ({
    id,
    name,
    kind,
    parentId: null,
    active: true,
  })),
  page: { cursor: null, hasMore: false },
};

const demoEnvelopes: CursorPage<ApiEnvelope> = {
  data: fixtureEnvelopes.map((envelope, index) => ({
    id: `demo-envelope-${index}`,
    name: envelope.name,
    planned: { minorUnits: String(Math.round(envelope.planned * 100)), currency: "USD" },
    funded: { minorUnits: String(Math.round(envelope.funded * 100)), currency: "USD" },
    activity: { minorUnits: String(Math.round(envelope.activity * 100)), currency: "USD" },
    available: { minorUnits: String(Math.round(envelope.available * 100)), currency: "USD" },
    cadence: envelope.cadence,
    pacing: envelope.pacing === "on-track" ? "on_track" : envelope.pacing,
    rolloverPolicy: "positive",
  })),
  page: { cursor: null, hasMore: false },
};

const demoAccounts: CursorPage<ApiAccount> = {
  data: fixtureAccounts.map((account) => ({
    id: account.id,
    name: account.name,
    mask: account.mask,
    group:
      account.group === "Investments"
        ? "investment"
        : account.group === "Credit"
          ? "credit"
          : account.group === "Loans"
            ? "loan"
            : "cash",
    balance: { minorUnits: String(Math.round(account.balance * 100)), currency: "USD" },
    syncStatus:
      account.status === "Manual"
        ? "manual"
        : account.status === "Attention"
          ? "attention"
          : "healthy",
    updatedAt: "2026-07-16T12:00:00.000Z",
  })),
  page: { cursor: null, hasMore: false },
};

const demoRuleConditions: unknown[] = [
  { field: "merchant", operator: "exact", value: "Whole Foods Market", caseSensitive: false },
  {
    all: [
      {
        field: "normalizedDescription",
        operator: "contains",
        value: "PAYROLL",
        caseSensitive: false,
      },
      { field: "direction", operator: "exact", value: "inflow" },
    ],
  },
  {
    field: "normalizedDescription",
    operator: "startsWith",
    value: "METRO FUEL",
    caseSensitive: false,
  },
  {
    all: [
      { field: "merchant", operator: "exact", value: "Vanguard", caseSensitive: false },
      { field: "accountId", operator: "exact", value: "acc_01", caseSensitive: false },
    ],
  },
];

const demoRuleActions: unknown[][] = [
  [
    { type: "setCategory", categoryId: "category-groceries" },
    { type: "setEnvelope", envelopeId: "demo-envelope-1" },
  ],
  [
    { type: "setCategory", categoryId: "category-income" },
    { type: "setFlag", flag: "income", value: true },
  ],
  [{ type: "setCategory", categoryId: "category-transportation" }],
  [
    { type: "setCategory", categoryId: "category-transfer" },
    { type: "setFlag", flag: "transfer", value: true },
  ],
];

const demoRules: CursorPage<ApiRule> = {
  data: fixtureRules.map((rule, index) => ({
    id: rule.id,
    name: rule.name,
    priority: rule.priority,
    enabled: rule.enabled,
    origin:
      rule.source === "System" ? "system" : rule.source === "Approved AI" ? "approved_ai" : "user",
    conditions: demoRuleConditions[index],
    actions: demoRuleActions[index] ?? [],
    matchCount: rule.matches,
    lastMatchedAt: rule.last,
  })),
  page: { cursor: null, hasMore: false },
};

const suggestionFixtures: SuggestionView[] = [
  {
    id: "ai_01",
    merchant: "Corner Table",
    raw: "TST* CORNER TABLE",
    category: "Dining",
    confidence: 72,
    amount: -48.16,
    rationale: "Similar local restaurant merchants were categorized as Dining.",
    proposal: "Merchant is exactly “Corner Table” → Dining",
  },
  {
    id: "ai_02",
    merchant: "Home Supply",
    raw: "HOME SUPPLY #108",
    category: "Home",
    confidence: 61,
    amount: -118.74,
    rationale: "The merchant suggests household supplies, but local history is still limited.",
    proposal: "Description starts with “Home Supply” → Home",
  },
];

const demoSuggestions: CursorPage<ApiAiSuggestion> = {
  data: suggestionFixtures.map((suggestion) => ({
    id: suggestion.id,
    transactionId: suggestion.id.replace("ai", "txn"),
    merchant: suggestion.merchant,
    categoryId: suggestion.category.toLowerCase(),
    categoryName: suggestion.category,
    confidence: suggestion.confidence / 100,
    rationale: suggestion.rationale,
    amount: { minorUnits: String(Math.round(suggestion.amount * 100)), currency: "USD" },
    rawDescription: suggestion.raw,
    proposedRule: {
      name: `${suggestion.merchant} ${suggestion.category}`,
      conditions: {},
      actions: {},
    },
    status: "pending",
  })),
  page: { cursor: null, hasMore: false },
};

function normalized(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function demoConditionMatches(
  transaction: (typeof fixtureTransactions)[number],
  value: unknown,
): boolean {
  const condition = asRecord(value);
  if (!condition) return false;
  if (Array.isArray(condition.all))
    return condition.all.every((child) => demoConditionMatches(transaction, child));
  if (Array.isArray(condition.any))
    return condition.any.some((child) => demoConditionMatches(transaction, child));
  if (condition.not) return !demoConditionMatches(transaction, condition.not);
  if (condition.field === "merchant")
    return normalized(transaction.merchant) === normalized(String(condition.value));
  if (
    ["description", "rawDescription", "normalizedDescription"].includes(String(condition.field))
  ) {
    const left = normalized(transaction.rawDescription);
    const right = normalized(String(condition.value));
    if (condition.operator === "exact") return left === right;
    if (condition.operator === "startsWith") return left.startsWith(right);
    if (condition.operator === "endsWith") return left.endsWith(right);
    if (condition.operator === "regex") {
      try {
        return new RegExp(String(condition.value), "iu").test(transaction.rawDescription);
      } catch {
        return false;
      }
    }
    return left.includes(right);
  }
  if (condition.field === "direction") {
    return (
      condition.value ===
      (transaction.amount > 0 ? "inflow" : transaction.amount < 0 ? "outflow" : "zero")
    );
  }
  if (condition.field === "status")
    return condition.value === (transaction.pending ? "pending" : "posted");
  if (condition.field === "accountId") {
    return (
      fixtureAccounts.find((account) => account.name === transaction.account)?.id ===
      condition.value
    );
  }
  if (condition.field === "amount") {
    const minor = BigInt(Math.round(transaction.amount * 100));
    if (condition.operator === "exact") return minor === BigInt(String(condition.value));
    const absolute = minor < 0n ? -minor : minor;
    return (
      absolute >= BigInt(String(condition.minimum)) && absolute <= BigInt(String(condition.maximum))
    );
  }
  return false;
}

function demoTransaction(transaction: (typeof fixtureTransactions)[number]): ApiTransaction {
  const accountId = fixtureAccounts.find((account) => account.name === transaction.account)?.id;
  return {
    id: transaction.id,
    ...(accountId ? { accountId } : {}),
    effectiveDate: "2026-07-16",
    description: transaction.rawDescription,
    merchant: transaction.merchant,
    amount: { minorUnits: String(Math.round(transaction.amount * 100)), currency: "USD" },
    accountName: transaction.account,
    categoryName: transaction.category,
    status: transaction.pending ? "pending" : "posted",
    reviewState: transaction.needsReview ? "needs_review" : "ready",
    source: transaction.provenance.startsWith("CSV") ? "import" : "simplefin",
    tags: [],
  };
}

const demoAutomationTransactions: CursorPage<ApiTransaction> = {
  data: fixtureTransactions.map(demoTransaction),
  page: { cursor: null, hasMore: false },
};

function previewDemoRule(
  input: Pick<ApiRuleWriteInput, "conditions" | "actions">,
  rules: ApiRule[],
  excludeRuleId?: string,
): ApiRulePreview {
  const matching = fixtureTransactions.filter((transaction) =>
    demoConditionMatches(transaction, input.conditions),
  );
  const conflicts = rules.filter(
    (rule) =>
      rule.enabled &&
      rule.id !== excludeRuleId &&
      matching.some((transaction) => demoConditionMatches(transaction, rule.conditions)),
  );
  return {
    matchCount: matching.length,
    aggregateAmount: {
      minorUnits: String(
        Math.round(matching.reduce((sum, transaction) => sum + transaction.amount, 0) * 100),
      ),
      currency: "USD",
    },
    samples: matching.slice(0, 20).map(demoTransaction),
    conflicts,
  };
}

function toSuggestionView(suggestion: ApiAiSuggestion): SuggestionView {
  return {
    id: suggestion.id,
    merchant: suggestion.merchant,
    raw: suggestion.rawDescription ?? suggestion.merchant,
    category: suggestion.categoryName,
    confidence: Math.round(suggestion.confidence * 100),
    amount: suggestion.amount ? Number(suggestion.amount.minorUnits) / 100 : 0,
    rationale: suggestion.rationale,
    proposal:
      suggestion.proposedRule?.name ?? `Categorize this merchant as ${suggestion.categoryName}`,
  };
}

function ConditionEditor({
  condition,
  index,
  accounts,
  onChange,
  onRemove,
}: {
  condition: ConditionDraft;
  index: number;
  accounts: ApiAccount[];
  onChange: (patch: Partial<ConditionDraft>) => void;
  onRemove: () => void;
}) {
  const setField = (field: ConditionField) => {
    const replacement = emptyCondition(field);
    onChange({
      field,
      operator: replacement.operator,
      value: replacement.value,
      minimum: "",
      maximum: "",
    });
  };
  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Stack direction={{ xs: "column", sm: "row" }} gap={2} alignItems={{ sm: "center" }}>
        <Select
          size="small"
          value={condition.field}
          onChange={(event) => setField(event.target.value as ConditionField)}
          inputProps={{ "aria-label": `Condition ${index + 1} field` }}
          sx={{ minWidth: 155 }}
        >
          <MenuItem value="merchant">Merchant</MenuItem>
          <MenuItem value="description">Description</MenuItem>
          <MenuItem value="direction">Direction</MenuItem>
          <MenuItem value="amount">Amount</MenuItem>
          <MenuItem value="account">Account</MenuItem>
          <MenuItem value="status">Posting status</MenuItem>
        </Select>
        {condition.field === "description" ? (
          <Select
            size="small"
            value={condition.operator}
            onChange={(event) => onChange({ operator: event.target.value })}
            inputProps={{ "aria-label": `Condition ${index + 1} operator` }}
            sx={{ minWidth: 135 }}
          >
            <MenuItem value="exact">is exactly</MenuItem>
            <MenuItem value="contains">contains</MenuItem>
            <MenuItem value="startsWith">starts with</MenuItem>
            <MenuItem value="endsWith">ends with</MenuItem>
            <MenuItem value="regex">safe regex</MenuItem>
          </Select>
        ) : null}
        {condition.field === "amount" ? (
          <Select
            size="small"
            value={condition.operator}
            onChange={(event) => onChange({ operator: event.target.value })}
            inputProps={{ "aria-label": `Condition ${index + 1} operator` }}
            sx={{ minWidth: 150 }}
          >
            <MenuItem value="absoluteBetween">absolute value between</MenuItem>
            <MenuItem value="exact">is exactly</MenuItem>
          </Select>
        ) : null}
        {condition.field === "merchant" || condition.field === "description" ? (
          <TextField
            fullWidth
            size="small"
            label={condition.field === "merchant" ? "Merchant name" : "Description text"}
            value={condition.value}
            onChange={(event) => onChange({ value: event.target.value })}
          />
        ) : null}
        {condition.field === "direction" ? (
          <Select
            fullWidth
            size="small"
            value={condition.value}
            onChange={(event) => onChange({ value: event.target.value })}
            inputProps={{ "aria-label": `Condition ${index + 1} direction` }}
          >
            <MenuItem value="outflow">Money out</MenuItem>
            <MenuItem value="inflow">Money in</MenuItem>
            <MenuItem value="zero">Zero amount</MenuItem>
          </Select>
        ) : null}
        {condition.field === "amount" && condition.operator === "exact" ? (
          <TextField
            fullWidth
            size="small"
            label="Exact amount"
            value={condition.value}
            onChange={(event) => onChange({ value: event.target.value })}
            inputProps={{ inputMode: "decimal" }}
          />
        ) : null}
        {condition.field === "amount" && condition.operator === "absoluteBetween" ? (
          <Stack direction="row" gap={2} sx={{ flex: 1 }}>
            <TextField
              fullWidth
              size="small"
              label="Minimum"
              value={condition.minimum}
              onChange={(event) => onChange({ minimum: event.target.value })}
              inputProps={{ inputMode: "decimal" }}
            />
            <TextField
              fullWidth
              size="small"
              label="Maximum"
              value={condition.maximum}
              onChange={(event) => onChange({ maximum: event.target.value })}
              inputProps={{ inputMode: "decimal" }}
            />
          </Stack>
        ) : null}
        {condition.field === "account" ? (
          <Select
            fullWidth
            size="small"
            value={condition.value}
            displayEmpty
            onChange={(event) => onChange({ value: event.target.value })}
            inputProps={{ "aria-label": `Condition ${index + 1} account` }}
          >
            <MenuItem value="" disabled>
              Select account
            </MenuItem>
            {accounts.map((account) => (
              <MenuItem key={account.id} value={account.id}>
                {account.name} · {account.mask || "no mask"}
              </MenuItem>
            ))}
          </Select>
        ) : null}
        {condition.field === "status" ? (
          <Select
            fullWidth
            size="small"
            value={condition.value}
            onChange={(event) => onChange({ value: event.target.value })}
            inputProps={{ "aria-label": `Condition ${index + 1} status` }}
          >
            <MenuItem value="posted">Posted</MenuItem>
            <MenuItem value="pending">Pending</MenuItem>
          </Select>
        ) : null}
        <IconButton aria-label={`Remove condition ${index + 1}`} onClick={onRemove}>
          <CloseRounded fontSize="small" />
        </IconButton>
      </Stack>
    </Paper>
  );
}

function ActionEditor({
  action,
  index,
  categories,
  envelopes,
  onChange,
  onRemove,
}: {
  action: ActionDraft;
  index: number;
  categories: ApiCategory[];
  envelopes: ApiEnvelope[];
  onChange: (patch: Partial<ActionDraft>) => void;
  onRemove: () => void;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Stack direction={{ xs: "column", sm: "row" }} gap={2} alignItems={{ sm: "center" }}>
        <Select
          size="small"
          value={action.field}
          onChange={(event) => onChange({ field: event.target.value as ActionField, value: "" })}
          inputProps={{ "aria-label": `Action ${index + 1} type` }}
          sx={{ minWidth: 170 }}
        >
          <MenuItem value="category">Set category</MenuItem>
          <MenuItem value="envelope">Attach budget</MenuItem>
          <MenuItem value="review">Review state</MenuItem>
          <MenuItem value="flag">Set money flag</MenuItem>
          <MenuItem value="merchant">Normalize merchant</MenuItem>
        </Select>
        {action.field === "category" ? (
          <Select
            fullWidth
            size="small"
            value={action.value}
            displayEmpty
            onChange={(event) => onChange({ value: event.target.value })}
            inputProps={{ "aria-label": `Action ${index + 1} category` }}
          >
            <MenuItem value="" disabled>
              Select category
            </MenuItem>
            {categories
              .filter((category) => category.active)
              .map((category) => (
                <MenuItem key={category.id} value={category.id}>
                  {category.name} · {category.kind}
                </MenuItem>
              ))}
          </Select>
        ) : null}
        {action.field === "envelope" ? (
          <Select
            fullWidth
            size="small"
            value={action.value}
            displayEmpty
            onChange={(event) => onChange({ value: event.target.value })}
            inputProps={{ "aria-label": `Action ${index + 1} budget envelope` }}
          >
            <MenuItem value="" disabled>
              Select budget envelope
            </MenuItem>
            {envelopes
              .filter((envelope) => envelope.isActive !== false)
              .map((envelope) => (
                <MenuItem key={envelope.id} value={envelope.id}>
                  {envelope.name}
                </MenuItem>
              ))}
          </Select>
        ) : null}
        {action.field === "review" ? (
          <Select
            fullWidth
            size="small"
            value={action.booleanValue ? "request" : "clear"}
            onChange={(event) => onChange({ booleanValue: event.target.value === "request" })}
            inputProps={{ "aria-label": `Action ${index + 1} review state` }}
          >
            <MenuItem value="request">Request review</MenuItem>
            <MenuItem value="clear">Clear review request</MenuItem>
          </Select>
        ) : null}
        {action.field === "flag" ? (
          <>
            <Select
              size="small"
              value={action.flag}
              onChange={(event) => onChange({ flag: event.target.value as ActionDraft["flag"] })}
              inputProps={{ "aria-label": `Action ${index + 1} flag` }}
              sx={{ minWidth: 175 }}
            >
              <MenuItem value="income">Income</MenuItem>
              <MenuItem value="transfer">Transfer</MenuItem>
              <MenuItem value="reimbursement">Reimbursement</MenuItem>
              <MenuItem value="reportingExcluded">Excluded from reports</MenuItem>
            </Select>
            <Select
              fullWidth
              size="small"
              value={action.booleanValue ? "yes" : "no"}
              onChange={(event) => onChange({ booleanValue: event.target.value === "yes" })}
              inputProps={{ "aria-label": `Action ${index + 1} flag value` }}
            >
              <MenuItem value="yes">Turn on</MenuItem>
              <MenuItem value="no">Turn off</MenuItem>
            </Select>
          </>
        ) : null}
        {action.field === "merchant" ? (
          <TextField
            fullWidth
            size="small"
            label="Clean merchant name"
            value={action.value}
            onChange={(event) => onChange({ value: event.target.value })}
          />
        ) : null}
        <IconButton aria-label={`Remove action ${index + 1}`} onClick={onRemove}>
          <CloseRounded fontSize="small" />
        </IconButton>
      </Stack>
    </Paper>
  );
}

function RuleBuilder({
  open,
  rule,
  accounts,
  categories,
  envelopes,
  onClose,
  onPreview,
  onSave,
  saving,
  saveError,
}: {
  open: boolean;
  rule: ApiRule | null;
  accounts: ApiAccount[];
  categories: ApiCategory[];
  envelopes: ApiEnvelope[];
  onClose: () => void;
  onPreview: (input: ApiRuleWriteInput, excludeRuleId?: string) => Promise<ApiRulePreview>;
  onSave: (
    input: ApiRuleWriteInput,
    applyExisting: boolean,
    preview: ApiRulePreview,
  ) => Promise<void>;
  saving: boolean;
  saveError: string | null;
}) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const [draft, setDraft] = useState<BuilderDraft>(emptyBuilderDraft);
  const [preview, setPreview] = useState<ApiRulePreview | null>(null);
  const [previewFingerprint, setPreviewFingerprint] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [localError, setLocalError] = useState("");
  const [applyExisting, setApplyExisting] = useState(false);
  const fingerprint = JSON.stringify(draft);
  const previewIsCurrent = Boolean(preview && previewFingerprint === fingerprint);

  useEffect(() => {
    if (!open) return;
    setDraft(rule ? ruleToBuilderDraft(rule) : emptyBuilderDraft());
    setPreview(null);
    setPreviewFingerprint("");
    setLocalError("");
    setApplyExisting(false);
  }, [open, rule]);

  const updateCondition = (key: string, patch: Partial<ConditionDraft>) => {
    setDraft((current) => ({
      ...current,
      conditions: current.conditions.map((condition) =>
        condition.key === key ? { ...condition, ...patch } : condition,
      ),
    }));
  };
  const updateAction = (key: string, patch: Partial<ActionDraft>) => {
    setDraft((current) => ({
      ...current,
      actions: current.actions.map((action) =>
        action.key === key ? { ...action, ...patch } : action,
      ),
    }));
  };
  const runPreview = async () => {
    try {
      const input = buildRuleInput(draft);
      setLocalError("");
      setPreviewing(true);
      const result = await onPreview(input, rule?.id);
      setPreview(result);
      setPreviewFingerprint(fingerprint);
    } catch (caught) {
      setPreview(null);
      setLocalError(caught instanceof Error ? caught.message : "The rule could not be previewed.");
    } finally {
      setPreviewing(false);
    }
  };
  const save = async () => {
    try {
      const input = buildRuleInput(draft);
      setLocalError("");
      if (!preview || !previewIsCurrent) throw new Error("Run a fresh preview before saving.");
      await onSave(input, applyExisting, preview);
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "The rule could not be saved.");
    }
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={saving ? undefined : onClose}
      PaperProps={{ sx: { width: mobile ? "100%" : 640, maxWidth: "100%" } }}
    >
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        sx={{ p: 4, borderBottom: "1px solid", borderColor: "divider" }}
      >
        <Box>
          <Typography variant="h3">{rule ? `Edit ${rule.name}` : "Build a narrow rule"}</Typography>
          <Typography variant="caption" color="text.secondary">
            Every condition must match; higher priority evaluates first.
          </Typography>
        </Box>
        <IconButton onClick={onClose} disabled={saving} aria-label="Close rule builder">
          <CloseRounded />
        </IconButton>
      </Stack>
      <Box sx={{ p: { xs: 4, sm: 5 }, overflowY: "auto", flex: 1 }}>
        <Stack gap={3}>
          <TextField
            fullWidth
            label="Rule name"
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
          <Stack direction={{ xs: "column", sm: "row" }} gap={3}>
            <TextField
              fullWidth
              label="Priority"
              value={draft.priority}
              onChange={(event) =>
                setDraft((current) => ({ ...current, priority: event.target.value }))
              }
              helperText="Higher numbers run first"
              inputProps={{ inputMode: "numeric" }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />
              }
              label="Enabled"
              sx={{ minWidth: 140, alignSelf: "flex-start", mt: 1 }}
            />
          </Stack>
        </Stack>

        {draft.unsupported ? (
          <Alert severity="warning" sx={{ mt: 4 }}>
            This rule contains advanced conditions or actions the visual editor cannot safely
            preserve. Leave it unchanged, or replace it with a new visual rule.
          </Alert>
        ) : null}

        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="end"
          sx={{ mt: 6, mb: 2 }}
        >
          <Box>
            <Typography variant="overline" color="text.secondary">
              When all are true
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              Keep patterns specific enough to avoid accidental matches.
            </Typography>
          </Box>
          <Chip
            size="small"
            label={`${draft.conditions.length} condition${draft.conditions.length === 1 ? "" : "s"}`}
          />
        </Stack>
        <Stack gap={2}>
          {draft.conditions.map((condition, index) => (
            <ConditionEditor
              key={condition.key}
              condition={condition}
              index={index}
              accounts={accounts}
              onChange={(patch) => updateCondition(condition.key, patch)}
              onRemove={() =>
                setDraft((current) => ({
                  ...current,
                  conditions: current.conditions.filter((item) => item.key !== condition.key),
                }))
              }
            />
          ))}
          <Button
            variant="outlined"
            startIcon={<AddRounded />}
            disabled={draft.conditions.length >= 12}
            onClick={() =>
              setDraft((current) => ({
                ...current,
                conditions: [...current.conditions, emptyCondition("direction")],
              }))
            }
            sx={{ alignSelf: "flex-start" }}
          >
            Add condition
          </Button>
        </Stack>

        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="end"
          sx={{ mt: 6, mb: 2 }}
        >
          <Box>
            <Typography variant="overline" color="text.secondary">
              Then
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              Actions are deterministic and run in the order shown.
            </Typography>
          </Box>
          <Chip
            size="small"
            label={`${draft.actions.length} action${draft.actions.length === 1 ? "" : "s"}`}
          />
        </Stack>
        <Stack gap={2}>
          {draft.actions.map((action, index) => (
            <ActionEditor
              key={action.key}
              action={action}
              index={index}
              categories={categories}
              envelopes={envelopes}
              onChange={(patch) => updateAction(action.key, patch)}
              onRemove={() =>
                setDraft((current) => ({
                  ...current,
                  actions: current.actions.filter((item) => item.key !== action.key),
                }))
              }
            />
          ))}
          <Button
            variant="outlined"
            startIcon={<AddRounded />}
            disabled={draft.actions.length >= 8}
            onClick={() =>
              setDraft((current) => ({
                ...current,
                actions: [...current.actions, emptyAction("envelope")],
              }))
            }
            sx={{ alignSelf: "flex-start" }}
          >
            Add action
          </Button>
        </Stack>

        <Divider sx={{ my: 6 }} />
        <Stack
          direction={{ xs: "column", sm: "row" }}
          justifyContent="space-between"
          alignItems={{ sm: "center" }}
          gap={3}
        >
          <Box>
            <Typography variant="h3">Historical preview</Typography>
            <Typography variant="caption" color="text.secondary">
              A preview reads transactions but never changes them.
            </Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={<PlayArrowRounded />}
            disabled={previewing || draft.unsupported}
            onClick={() => void runPreview()}
          >
            {previewing ? "Checking…" : "Run preview"}
          </Button>
        </Stack>

        {preview && previewIsCurrent ? (
          <Paper variant="outlined" sx={{ mt: 4, overflow: "hidden" }}>
            <Stack
              direction="row"
              gap={2}
              alignItems="center"
              sx={{ p: 4, bgcolor: alpha(theme.palette.success.main, 0.07) }}
            >
              <CheckCircleRounded color="success" />
              <Box>
                <Typography variant="body2" fontWeight={750}>
                  {preview.matchCount} historical match{preview.matchCount === 1 ? "" : "es"} ·{" "}
                  <Money value={Number(preview.aggregateAmount.minorUnits) / 100} sign />
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Saving affects future imports and syncs. Existing transactions change only if you
                  opt in below.
                </Typography>
              </Box>
            </Stack>
            {preview.samples.slice(0, 5).map((transaction) => (
              <Stack
                key={transaction.id}
                direction="row"
                alignItems="center"
                gap={2}
                sx={{ px: 4, py: 2.5, borderTop: "1px solid", borderColor: "divider" }}
              >
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="body2" fontWeight={680} noWrap>
                    {transaction.merchant}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {transaction.accountName} · {transaction.effectiveDate}
                  </Typography>
                </Box>
                <Typography variant="body2" fontWeight={700}>
                  <Money value={Number(transaction.amount.minorUnits) / 100} sign />
                </Typography>
              </Stack>
            ))}
          </Paper>
        ) : null}
        {preview && !previewIsCurrent ? (
          <Alert severity="info" sx={{ mt: 4 }}>
            The rule changed. Run the preview again before saving.
          </Alert>
        ) : null}
        {preview && previewIsCurrent && preview.conflicts.length ? (
          <Alert severity="warning" icon={<WarningAmberRounded />} sx={{ mt: 3 }}>
            Also overlaps {preview.conflicts.map((conflict) => conflict.name).join(", ")}. Automatic
            runs resolve overlaps by priority, then specificity, and keep the competing rule IDs in
            the audit trail.
          </Alert>
        ) : null}
        {preview && previewIsCurrent && preview.matchCount > 0 ? (
          <FormControlLabel
            sx={{ mt: 3, alignItems: "flex-start" }}
            control={
              <Switch
                checked={applyExisting}
                onChange={(event) => setApplyExisting(event.target.checked)}
              />
            }
            label={
              <Box>
                <Typography variant="body2" fontWeight={680}>
                  Apply to these {preview.matchCount} existing matches after saving
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Off by default. The apply run receives its own auditable batch ID.
                </Typography>
              </Box>
            }
          />
        ) : null}
        {localError ? (
          <Alert severity="error" sx={{ mt: 4 }}>
            {localError}
          </Alert>
        ) : null}
        {saveError ? (
          <Alert severity="error" sx={{ mt: 4 }}>
            {saveError}
          </Alert>
        ) : null}
      </Box>
      <Stack
        direction="row"
        justifyContent="flex-end"
        gap={2}
        sx={{ p: 4, borderTop: "1px solid", borderColor: "divider" }}
      >
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={!previewIsCurrent || saving || draft.unsupported}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : rule ? "Save changes" : "Save rule"}
        </Button>
      </Stack>
    </Drawer>
  );
}

function RuleRow({
  rule,
  summary,
  onEdit,
  onDelete,
  onToggle,
  pending,
}: {
  rule: ApiRule;
  summary: string;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
  pending: boolean;
}) {
  const [enabled, setEnabled] = useState(rule.enabled);
  useEffect(() => setEnabled(rule.enabled), [rule.enabled]);
  const source =
    rule.origin === "approved_ai" ? "Approved AI" : rule.origin === "system" ? "System" : "You";
  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      alignItems={{ xs: "stretch", sm: "center" }}
      gap={3}
      sx={{ p: 4, borderTop: "1px solid", borderColor: "divider" }}
    >
      <Stack direction="row" alignItems="center" gap={2.5} sx={{ minWidth: 0, flex: 1 }}>
        <Box
          sx={{
            width: 42,
            height: 42,
            borderRadius: 2.5,
            display: "grid",
            placeItems: "center",
            flex: "0 0 auto",
            bgcolor: alpha("#1F9D72", 0.1),
            color: "success.main",
          }}
        >
          <RuleRounded fontSize="small" />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
            <Typography variant="body2" fontWeight={720}>
              {rule.name}
            </Typography>
            <StatusChip label={source} tone={source === "Approved AI" ? "info" : "neutral"} />
            {!rule.enabled ? <StatusChip label="Paused" tone="warning" /> : null}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
            {summary}
          </Typography>
        </Box>
      </Stack>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent={{ xs: "space-between", sm: "flex-end" }}
        gap={2}
      >
        <Box sx={{ textAlign: { xs: "left", sm: "right" }, mr: 1 }}>
          <Typography variant="body2" fontWeight={700}>
            {rule.matchCount} match{rule.matchCount === 1 ? "" : "es"}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {formatLastMatched(rule.lastMatchedAt)} · priority {rule.priority}
          </Typography>
        </Box>
        <Switch
          checked={enabled}
          disabled={pending}
          onChange={(event) => {
            const next = event.target.checked;
            setEnabled(next);
            onToggle(next);
          }}
          inputProps={{ "aria-label": `${enabled ? "Disable" : "Enable"} ${rule.name}` }}
        />
        {rule.origin === "system" ? (
          <Tooltip title="System rules can be paused, but their logic is read-only.">
            <span>
              <IconButton aria-label={`${rule.name} is read-only`} disabled>
                <ShieldRounded fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        ) : (
          <>
            <IconButton aria-label={`Edit ${rule.name}`} onClick={onEdit}>
              <EditRounded fontSize="small" />
            </IconButton>
            <IconButton aria-label={`Delete ${rule.name}`} color="error" onClick={onDelete}>
              <DeleteOutlineRounded fontSize="small" />
            </IconButton>
          </>
        )}
      </Stack>
    </Stack>
  );
}

function SuggestionCard({
  suggestion,
  onReview,
}: {
  suggestion: SuggestionView;
  onReview: (status: "accepted" | "rejected", createRule: boolean) => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const review = async (status: "accepted" | "rejected", createRule: boolean) => {
    try {
      setWorking(true);
      setError("");
      await onReview(status, createRule);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review failed.");
      setWorking(false);
    }
  };
  return (
    <Card>
      <CardContent sx={{ p: 5 }}>
        <Stack direction="row" justifyContent="space-between" gap={3}>
          <Stack direction="row" gap={3}>
            <Box
              sx={{
                width: 44,
                height: 44,
                borderRadius: 3,
                display: "grid",
                placeItems: "center",
                bgcolor: alpha("#8B6CCF", 0.1),
                color: "#8B6CCF",
              }}
            >
              <SmartToyRounded />
            </Box>
            <Box>
              <Typography variant="h3">{suggestion.merchant}</Typography>
              <Typography variant="caption" color="text.secondary">
                {suggestion.raw}
              </Typography>
            </Box>
          </Stack>
          <Box sx={{ textAlign: "right" }}>
            <Typography variant="h3">
              <Money value={suggestion.amount} sign />
            </Typography>
            <StatusChip label={`${suggestion.confidence}% confidence`} tone="warning" />
          </Box>
        </Stack>
        <Divider sx={{ my: 4 }} />
        <Stack gap={2}>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Suggested category
            </Typography>
            <Typography variant="body2" fontWeight={720}>
              {suggestion.category}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Why
            </Typography>
            <Typography variant="body2">{suggestion.rationale}</Typography>
          </Box>
          <Box sx={{ p: 3.5, borderRadius: 3, bgcolor: "action.hover" }}>
            <Typography variant="caption" color="text.secondary">
              Narrow reusable rule proposal
            </Typography>
            <Typography variant="body2" fontWeight={700} sx={{ mt: 1 }}>
              {suggestion.proposal}
            </Typography>
          </Box>
        </Stack>
        {error ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {error}
          </Alert>
        ) : null}
        <Stack
          direction={{ xs: "column-reverse", sm: "row" }}
          justifyContent="flex-end"
          gap={2}
          sx={{ mt: 5 }}
        >
          <Button color="inherit" disabled={working} onClick={() => void review("rejected", false)}>
            Reject
          </Button>
          <Button
            variant="outlined"
            disabled={working}
            onClick={() => void review("accepted", false)}
          >
            Approve category only
          </Button>
          <Button
            variant="contained"
            disabled={working}
            onClick={() => void review("accepted", true)}
          >
            {working ? "Saving…" : "Approve + rule"}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

export function AutomationPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<"rules" | "ai">(() =>
    searchParams.get("tab") === "ai" ? "ai" : "rules",
  );
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ApiRule | null>(null);
  const [deletingRule, setDeletingRule] = useState<ApiRule | null>(null);
  const [search, setSearch] = useState("");
  const demo = isDemoMode();
  const queryClient = useQueryClient();

  const rulesQuery = useQuery({
    queryKey: ["rules"],
    queryFn: api.rules,
    initialData: demo ? demoRules : undefined,
    enabled: !demo,
    retry: 1,
  });
  const suggestionsQuery = useQuery({
    queryKey: ["ai-suggestions"],
    queryFn: api.aiSuggestions,
    initialData: demo ? demoSuggestions : undefined,
    enabled: !demo,
    retry: 1,
  });
  const categoriesQuery = useQuery({
    queryKey: ["categories"],
    queryFn: api.categories,
    initialData: demo ? demoCategories : undefined,
    enabled: !demo,
    retry: 1,
  });
  const envelopesQuery = useQuery({
    queryKey: ["envelopes"],
    queryFn: api.envelopes,
    initialData: demo ? demoEnvelopes : undefined,
    enabled: !demo,
    retry: 1,
  });
  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: api.accounts,
    initialData: demo ? demoAccounts : undefined,
    enabled: !demo,
    retry: 1,
  });
  const transactionsQuery = useQuery({
    queryKey: ["transactions", "automation-coverage"],
    queryFn: () => api.transactions("limit=100"),
    initialData: demo ? demoAutomationTransactions : undefined,
    enabled: !demo,
    retry: 1,
  });

  const rules = rulesQuery.data?.data ?? [];
  const categories = categoriesQuery.data?.data ?? [];
  const envelopes = envelopesQuery.data?.data ?? [];
  const accounts = accountsQuery.data?.data ?? [];
  const suggestionViews =
    suggestionsQuery.data?.data.filter((item) => item.status === "pending").map(toSuggestionView) ??
    [];
  const coverageTransactions = (transactionsQuery.data?.data ?? []).filter(
    (transaction) => !transaction.isExcluded && !transaction.isTransfer,
  );
  const categorizedCount = coverageTransactions.filter(
    (transaction) => transaction.categoryName.toLocaleLowerCase() !== "uncategorized",
  ).length;
  const readyCount = coverageTransactions.filter(
    (transaction) =>
      transaction.categoryName.toLocaleLowerCase() !== "uncategorized" &&
      transaction.reviewState !== "needs_review",
  ).length;
  const activeRules = rules.filter((rule) => rule.enabled);
  const aiRules = activeRules.filter((rule) => rule.origin === "approved_ai");
  const handledCount = rules.reduce((sum, rule) => sum + rule.matchCount, 0);

  const summaries = useMemo(
    () =>
      new Map(
        rules.map((rule) => [
          rule.id,
          `${describeCondition(rule.conditions, accounts)} → ${describeActions(rule.actions, categories, envelopes)}`,
        ]),
      ),
    [accounts, categories, envelopes, rules],
  );
  const filteredRules = rules.filter((rule) => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return true;
    return `${rule.name} ${summaries.get(rule.id) ?? ""} ${rule.origin}`
      .toLocaleLowerCase()
      .includes(needle);
  });

  const setDemoRules = (update: (current: ApiRule[]) => ApiRule[]) => {
    queryClient.setQueryData<CursorPage<ApiRule>>(["rules"], (current) => ({
      data: update(current?.data ?? []),
      page: current?.page ?? { cursor: null, hasMore: false },
    }));
  };
  const openNewRule = () => {
    setEditingRule(null);
    setBuilderOpen(true);
  };
  useEffect(() => {
    if (searchParams.get("action") !== "add") return;
    openNewRule();
    const next = new URLSearchParams(searchParams);
    next.delete("action");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  useEffect(() => {
    const requestedTab = searchParams.get("tab");
    if (requestedTab === "ai" || requestedTab === "rules") setTab(requestedTab);
  }, [searchParams]);

  const updateRule = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      if (demo) {
        setDemoRules((current) =>
          current.map((rule) => (rule.id === id ? { ...rule, enabled } : rule)),
        );
        return;
      }
      await api.updateRule(id, { enabled });
    },
    onSuccess: async () => {
      if (!demo) await queryClient.invalidateQueries({ queryKey: ["rules"] });
    },
  });
  const saveRule = useMutation({
    mutationFn: async ({
      input,
      applyExisting,
      preview,
    }: {
      input: ApiRuleWriteInput;
      applyExisting: boolean;
      preview: ApiRulePreview;
    }) => {
      if (demo) {
        const timestamp = new Date().toISOString();
        if (editingRule) {
          setDemoRules((current) =>
            current.map((rule) => {
              if (rule.id !== editingRule.id) return rule;
              const lastMatchedAt =
                applyExisting && preview.matchCount ? timestamp : rule.lastMatchedAt;
              return {
                ...rule,
                ...input,
                origin: rule.origin,
                matchCount: applyExisting ? rule.matchCount + preview.matchCount : rule.matchCount,
                ...(lastMatchedAt ? { lastMatchedAt } : {}),
                updatedAt: timestamp,
              };
            }),
          );
        } else {
          setDemoRules((current) => [
            {
              id: `demo-rule-${Date.now()}`,
              ...input,
              origin: "user",
              matchCount: applyExisting ? preview.matchCount : 0,
              ...(applyExisting && preview.matchCount ? { lastMatchedAt: timestamp } : {}),
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            ...current,
          ]);
        }
        return;
      }
      const saved = editingRule
        ? await api.updateRule(editingRule.id, {
            name: input.name,
            priority: input.priority,
            enabled: input.enabled,
            conditions: input.conditions,
            actions: input.actions,
          })
        : await api.createRule(input);
      if (applyExisting) await api.applyRule(saved.id);
    },
    onSuccess: async () => {
      setBuilderOpen(false);
      setEditingRule(null);
      if (!demo) await queryClient.invalidateQueries({ queryKey: ["rules"] });
    },
  });
  const deleteRule = useMutation({
    mutationFn: async (rule: ApiRule) => {
      if (demo) {
        setDemoRules((current) => current.filter((item) => item.id !== rule.id));
        return;
      }
      await api.deleteRule(rule.id);
    },
    onSuccess: async () => {
      setDeletingRule(null);
      if (!demo) await queryClient.invalidateQueries({ queryKey: ["rules"] });
    },
  });
  const reviewSuggestion = useMutation({
    mutationFn: async ({
      id,
      status,
      createRule,
    }: {
      id: string;
      status: "accepted" | "rejected";
      createRule: boolean;
    }) => {
      if (demo) {
        queryClient.setQueryData<CursorPage<ApiAiSuggestion>>(["ai-suggestions"], (current) => ({
          data: (current?.data ?? []).map((suggestion) =>
            suggestion.id === id ? { ...suggestion, status } : suggestion,
          ),
          page: current?.page ?? { cursor: null, hasMore: false },
        }));
        return;
      }
      await api.reviewAiSuggestion(id, { status, createRule });
    },
    onSuccess: async () => {
      if (!demo) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["ai-suggestions"] }),
          queryClient.invalidateQueries({ queryKey: ["rules"] }),
        ]);
      }
    },
  });

  const previewRule = async (input: ApiRuleWriteInput, excludeRuleId?: string) => {
    if (demo) return previewDemoRule(input, rules, excludeRuleId);
    return api.previewRule({
      name: input.name,
      priority: input.priority,
      conditions: input.conditions,
      actions: input.actions,
      ...(excludeRuleId ? { excludeRuleId } : {}),
    });
  };

  const dependencyError =
    categoriesQuery.isError || envelopesQuery.isError || accountsQuery.isError;
  const mutationError = [updateRule.error, deleteRule.error].find(
    (error) => error instanceof Error,
  );

  if (rulesQuery.isPending) {
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Automation"
          title="Loading automation"
          description="Reading deterministic rules and match history."
        />
        <LoadingCard rows={7} />
      </Stack>
    );
  }
  if (rulesQuery.isError) {
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Automation"
          title="Automation unavailable"
          description="No rule was evaluated or changed."
        />
        <ErrorState
          message="BetterWealth could not load automation rules."
          onRetry={() => rulesQuery.refetch()}
        />
      </Stack>
    );
  }

  return (
    <Stack gap={5}>
      <PageHeader
        eyebrow="Automation"
        title="Trust is earned one narrow rule at a time"
        description="Deterministic rules categorize, budget, and flag transactions. Every new pattern is previewed before it can touch your ledger."
        actions={
          <Button variant="contained" startIcon={<AddRounded />} onClick={openNewRule}>
            New rule
          </Button>
        }
      />
      <PlanFlowCard
        testId="automation-money-pipeline"
        title="From raw swipe to trusted budget"
        description="Every imported pattern moves through deterministic matching and an approval-gated review before it becomes dependable planning data."
        steps={[
          {
            id: "observe",
            label: "Observe",
            value: coverageTransactions.length
              ? coverageTransactions.length.toLocaleString()
              : "No activity",
            detail: coverageTransactions.length
              ? "Latest non-transfer ledger entries checked for repeatable patterns"
              : "Sync or import transactions to begin pattern discovery.",
            icon: <SearchRounded />,
            to: "/transactions",
            tone: "#4A7FD1",
            status: transactionsQuery.isError ? "Coverage unavailable" : "Live ledger sample",
            statusTone: transactionsQuery.isError ? "warning" : "info",
          },
          {
            id: "rules",
            label: "Match",
            value: activeRules.length.toLocaleString(),
            detail: `${aiRules.length} AI-approved · ${handledCount.toLocaleString()} auditable historical matches`,
            icon: <RuleRounded />,
            to: "/automation",
            tone: "#1F9D72",
            status: activeRules.length ? "Deterministic rules" : "Build first rule",
            statusTone: activeRules.length ? "positive" : "warning",
          },
          {
            id: "review",
            label: "Review",
            value: suggestionViews.length.toLocaleString(),
            detail: suggestionViews.length
              ? "AI proposals waiting for category-only or category-plus-rule approval"
              : "No AI proposal can change the ledger without your approval.",
            icon: <SmartToyRounded />,
            to: "/automation?tab=ai",
            tone: "#D98B2B",
            status: suggestionViews.length ? "Approval required" : "Queue clear",
            statusTone: suggestionViews.length ? "warning" : "positive",
          },
          {
            id: "ready",
            label: "Budget ready",
            value: coverageTransactions.length
              ? `${readyCount}/${coverageTransactions.length}`
              : "Waiting",
            detail: coverageTransactions.length
              ? `${categorizedCount} categorized; ${coverageTransactions.length - readyCount} still need a category or review`
              : "Coverage appears after the first imported ledger entries.",
            icon: <CheckCircleRounded />,
            to: "/budget",
            tone: "#8B6CCF",
            status:
              readyCount === coverageTransactions.length && coverageTransactions.length
                ? "Planning clean"
                : "Finish the queue",
            statusTone:
              readyCount === coverageTransactions.length && coverageTransactions.length
                ? "positive"
                : "warning",
          },
        ]}
        footer={
          <Stack
            direction={{ xs: "column", sm: "row" }}
            alignItems={{ xs: "flex-start", sm: "center" }}
            justifyContent="space-between"
            gap={2}
          >
            <Typography variant="body2" color="text.secondary">
              {coverageTransactions.length
                ? `${Math.round((readyCount / coverageTransactions.length) * 100)}% of this ledger sample is categorized and review-ready.`
                : "Coverage is intentionally not estimated until real ledger data exists."}
            </Typography>
            <Button
              size="small"
              endIcon={<PlayArrowRounded />}
              onClick={() => (suggestionViews.length ? setTab("ai") : openNewRule())}
            >
              {suggestionViews.length ? "Review next proposal" : "Teach a new pattern"}
            </Button>
          </Stack>
        }
      />
      <Card sx={{ p: 1 }}>
        <Tabs
          value={tab}
          onChange={(_, value: "rules" | "ai") => setTab(value)}
          aria-label="Automation sections"
        >
          <Tab value="rules" label="Rules" icon={<TuneRounded />} iconPosition="start" />
          <Tab
            value="ai"
            label={`AI review (${suggestionViews.length})`}
            icon={<AutoAwesomeRounded />}
            iconPosition="start"
          />
        </Tabs>
      </Card>

      {mutationError ? <Alert severity="error">{mutationError.message}</Alert> : null}
      {dependencyError ? (
        <Alert severity="warning">
          Categories, budgets, or accounts could not be loaded. Existing rules are safe, but the
          builder may have fewer choices until you retry.
        </Alert>
      ) : null}

      {tab === "rules" ? (
        <Card>
          <CardContent sx={{ p: 0 }}>
            <Box sx={{ p: 5 }}>
              <SectionHeader
                title="Categorization rules"
                description="Higher priority evaluates first; specificity breaks ties. System rules can be paused but not rewritten."
                action={
                  <TextField
                    placeholder="Search rules"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    inputProps={{ "aria-label": "Search rules" }}
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <SearchRounded />
                        </InputAdornment>
                      ),
                    }}
                  />
                }
              />
            </Box>
            {filteredRules.length ? (
              filteredRules.map((rule) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  summary={summaries.get(rule.id) ?? "Deterministic rule"}
                  pending={updateRule.isPending}
                  onEdit={() => {
                    setEditingRule(rule);
                    setBuilderOpen(true);
                  }}
                  onDelete={() => setDeletingRule(rule)}
                  onToggle={(enabled) => updateRule.mutate({ id: rule.id, enabled })}
                />
              ))
            ) : (
              <EmptyState
                icon={<RuleRounded />}
                title={search ? "No rules match that search" : "No rules yet"}
                description={
                  search
                    ? "Try a merchant, action, source, or rule name."
                    : "Create a narrow rule and preview historical matches before saving."
                }
                actionLabel={search ? "Clear search" : "Create rule"}
                onAction={search ? () => setSearch("") : openNewRule}
              />
            )}
          </CardContent>
        </Card>
      ) : null}

      {tab === "ai" ? (
        <>
          <Alert severity="info" icon={<ShieldRounded />}>
            Suggestions never apply themselves. Approving a category changes one transaction;
            “Approve + rule” also stores the narrow deterministic proposal for future matches.
          </Alert>
          {suggestionsQuery.isError ? (
            <ErrorState
              message="AI suggestions are unavailable; deterministic rules still work."
              onRetry={() => suggestionsQuery.refetch()}
            />
          ) : (
            <Stack gap={4}>
              {suggestionViews.map((suggestion) => (
                <SuggestionCard
                  key={suggestion.id}
                  suggestion={suggestion}
                  onReview={(status, createRule) =>
                    reviewSuggestion.mutateAsync({ id: suggestion.id, status, createRule })
                  }
                />
              ))}
              {!suggestionViews.length ? (
                <EmptyState
                  icon={<CheckCircleRounded />}
                  title="Review queue is clear"
                  description="Uncertain first-seen patterns appear here only when your AI integration and consent are enabled."
                  actionLabel="Refresh queue"
                  onAction={() => suggestionsQuery.refetch()}
                />
              ) : null}
            </Stack>
          )}
        </>
      ) : null}

      <RuleBuilder
        open={builderOpen}
        rule={editingRule}
        accounts={accounts}
        categories={categories}
        envelopes={envelopes}
        onClose={() => {
          setBuilderOpen(false);
          setEditingRule(null);
        }}
        onPreview={previewRule}
        onSave={(input, applyExisting, preview) =>
          saveRule.mutateAsync({ input, applyExisting, preview })
        }
        saving={saveRule.isPending}
        saveError={saveRule.error instanceof Error ? saveRule.error.message : null}
      />

      <Dialog
        open={Boolean(deletingRule)}
        onClose={deleteRule.isPending ? undefined : () => setDeletingRule(null)}
        aria-labelledby="delete-rule-title"
      >
        <DialogTitle id="delete-rule-title">Delete {deletingRule?.name ?? "rule"}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            Future transactions will stop using this rule. Existing categorized transactions and
            their audit history stay intact.
          </Typography>
          {deleteRule.error instanceof Error ? (
            <Alert severity="error" sx={{ mt: 3 }}>
              {deleteRule.error.message}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeletingRule(null)} disabled={deleteRule.isPending}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={!deletingRule || deleteRule.isPending}
            onClick={() => deletingRule && deleteRule.mutate(deletingRule)}
          >
            {deleteRule.isPending ? "Deleting…" : "Delete rule"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
