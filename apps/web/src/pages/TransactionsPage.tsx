import {
  AddRounded,
  AutoAwesomeRounded,
  CallSplitRounded,
  CheckCircleRounded,
  CloseRounded,
  CloudDownloadRounded,
  DeleteOutlineRounded,
  ExpandMoreRounded,
  FilterListRounded,
  LinkRounded,
  LocalOfferRounded,
  MoreHorizRounded,
  ReceiptLongRounded,
  RemoveCircleOutlineRounded,
  RuleRounded,
  SearchRounded,
  SwapHorizRounded,
  UploadFileRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  alpha,
  Box,
  Button,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  InputAdornment,
  ListItemIcon,
  MenuItem,
  Paper,
  Snackbar,
  Tab,
  Tabs,
  Tooltip,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  type ApiAccount,
  type ApiCategory,
  type ApiEnvelope,
  type ApiRefundLinkMatch,
  type ApiRule,
  type ApiTransaction,
  type ApiTransactionDetail,
  type ApiTransactionImportResult,
  type ApiTransferMatch,
  api,
  type CursorPage,
} from "../api";
import { Checkbox, Dialog, Drawer, Menu, Stack, TextField, Typography } from "../components/mui";
import { ErrorState, LoadingCard, Money, PageHeader, StatusChip } from "../components/ui";
import {
  accounts as fixtureAccounts,
  transactions as fixtureTransactions,
  type LedgerItem,
} from "../data";
import { isDemoMode } from "../demo";

export interface TransactionView extends LedgerItem {
  accountId: string;
  effectiveDate: string;
  amountMinorUnits: string;
  currency: string;
  status: ApiTransaction["status"];
  source: ApiTransaction["source"];
  tags: string[];
  isTransfer: boolean;
  isIncome: boolean;
  hasSplits: boolean;
  transferId?: string;
  refundLinkIds: string[];
  transferMatch?: ApiTransferMatch;
  refundLinkMatches: ApiRefundLinkMatch[];
}

export interface LedgerRangeFilters {
  minimum: string;
  maximum: string;
  fromDate: string;
  toDate: string;
}

type TransactionAction = "split" | "transfer" | "refund" | "rule";

export interface SplitDraft {
  amountMinorUnits: string;
  categoryId?: string;
  envelopeId?: string;
  memo?: string;
}

export type RuleCreateInput = Omit<ApiRule, "id" | "matchCount">;

export interface RulePreview {
  matchCount: number;
  aggregateAmount: { minorUnits: string; currency: string };
  samples: ApiTransaction[];
  conflicts: ApiRule[];
}

const demoApiTransactions: CursorPage<ApiTransaction> = {
  data: fixtureTransactions.map((transaction) => ({
    id: transaction.id,
    accountId:
      fixtureAccounts.find(({ name }) => name === transaction.account)?.id ?? "demo-account",
    effectiveDate: "2026-07-16",
    description: transaction.rawDescription,
    merchant: transaction.merchant,
    amount: {
      minorUnits: String(Math.round(transaction.amount * 100)),
      currency: "USD",
    },
    accountName: transaction.account,
    categoryName: transaction.category,
    status: transaction.pending ? "pending" : "posted",
    reviewState: transaction.needsReview ? "needs_review" : "ready",
    source: transaction.provenance.startsWith("CSV") ? "import" : "simplefin",
    note: transaction.note ?? "",
    tags: [],
    isTransfer: transaction.category === "Transfer",
    isExcluded: Boolean(transaction.excluded),
    isIncome: transaction.amount > 0 && transaction.category === "Income",
    hasSplits: false,
    ...(transaction.category === "Transfer"
      ? { transferId: `demo-transfer-${transaction.id}` }
      : {}),
    refundLinkIds: [],
  })),
  page: { cursor: null, hasMore: false },
};

const demoCategories: CursorPage<ApiCategory> = {
  data: (
    [
      ["category-groceries", "Groceries", "expense"],
      ["category-dining", "Dining", "expense"],
      ["category-utilities", "Utilities", "expense"],
      ["category-shopping", "Shopping", "expense"],
      ["category-entertainment", "Entertainment", "expense"],
      ["category-transportation", "Transportation", "expense"],
      ["category-income", "Income", "income"],
      ["category-transfer", "Transfer", "transfer"],
    ] satisfies Array<[string, string, ApiCategory["kind"]]>
  ).map(([id, name, kind]) => ({
    id,
    name,
    kind: kind as ApiCategory["kind"],
    parentId: null,
    active: true,
  })),
  page: { cursor: null, hasMore: false },
};

const demoEnvelopes: CursorPage<ApiEnvelope> = {
  data: ["Groceries", "Dining out", "Utilities", "Investing", "Home", "Subscriptions"].map(
    (name, index) => ({
      id: `demo-envelope-${index}`,
      name,
      planned: { minorUnits: "0", currency: "USD" },
      funded: { minorUnits: "0", currency: "USD" },
      activity: { minorUnits: "0", currency: "USD" },
      available: { minorUnits: "0", currency: "USD" },
      cadence: "month",
      pacing: "on_track",
      rolloverPolicy: "reset",
      transferredIn: { minorUnits: "0", currency: "USD" },
      transferredOut: { minorUnits: "0", currency: "USD" },
      parentId: null,
      categoryId: null,
      categoryIds: [],
      priority: index,
      minimumAmount: { minorUnits: "0", currency: "USD" },
      targetAmount: { minorUnits: "0", currency: "USD" },
      isRequired: false,
      isActive: true,
    }),
  ),
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
    balance: {
      minorUnits: String(Math.round(account.balance * 100)),
      currency: "USD",
    },
    syncStatus:
      account.status === "Attention"
        ? "attention"
        : account.status === "Manual"
          ? "manual"
          : "healthy",
    updatedAt: "2026-07-16T12:00:00.000Z",
  })),
  page: { cursor: null, hasMore: false },
};

function readableDate(value: string, fallbackIndex: number) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallbackIndex < 2 ? "Today" : "Earlier";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: parsed.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(parsed);
}

export function displayItems(page: CursorPage<ApiTransaction>): TransactionView[] {
  return page.data.map((item, index) => {
    const fallback = fixtureTransactions.find((candidate) => candidate.id === item.id);
    return {
      id: item.id,
      accountId: item.accountId,
      effectiveDate: item.effectiveDate,
      date: fallback?.date ?? readableDate(item.effectiveDate, index),
      merchant: item.merchant,
      rawDescription: item.description,
      account: item.accountName,
      accountMask: fallback?.accountMask ?? "••••",
      category: item.categoryName,
      envelope: item.envelopeName ?? "Unassigned",
      amount: Number(item.amount.minorUnits) / 100,
      amountMinorUnits: item.amount.minorUnits,
      currency: item.amount.currency,
      status: item.status,
      source: item.source,
      tags: item.tags,
      pending: item.status === "pending",
      needsReview: item.reviewState === "needs_review",
      recurring: item.isRecurring ?? false,
      excluded: item.isExcluded ?? fallback?.excluded ?? false,
      isTransfer: item.isTransfer ?? false,
      isIncome: item.isIncome ?? false,
      hasSplits: item.hasSplits ?? false,
      ...(item.transferId ? { transferId: item.transferId } : {}),
      refundLinkIds: item.refundLinkIds ?? [],
      ...(item.transfer ? { transferMatch: item.transfer } : {}),
      refundLinkMatches: item.refundLinks ?? [],
      note: item.note ?? "",
      provenance:
        item.provenance ??
        (item.source === "simplefin"
          ? "SimpleFIN provider import"
          : item.source === "import"
            ? "Reviewed file import"
            : "Manual entry"),
    };
  });
}

function formatMinorUnits(minorUnits: bigint, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(Number(minorUnits) / 100);
}

function minorUnitsToInput(minorUnits: bigint) {
  const absolute = minorUnits < 0n ? -minorUnits : minorUnits;
  return `${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

export function parsePositiveCurrencyMinorUnits(value: string): bigint | null {
  const normalized = value.trim().replace(/[$,]/g, "");
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return amount > 0n ? amount : null;
}

function directionLabel(item: TransactionView) {
  return BigInt(item.amountMinorUnits) < 0n ? "outflow" : "credit";
}

function candidateLabel(item: TransactionView) {
  return `${item.merchant} · ${item.account} · ${formatMinorUnits(BigInt(item.amountMinorUnits), item.currency)}`;
}

function hasSuggestedMatch(item: TransactionView) {
  return (
    item.transferMatch?.status === "suggested" ||
    item.refundLinkMatches.some(({ status }) => status === "suggested")
  );
}

export function matchesTransactionFilters(
  item: TransactionView,
  options: {
    query: string;
    tab: string;
    filters: string[];
    range: LedgerRangeFilters;
  },
) {
  const { query, tab, filters, range } = options;
  const matchesSearch =
    `${item.merchant} ${item.rawDescription} ${item.category} ${item.account} ${item.note ?? ""} ${item.amount} ${formatMinorUnits(BigInt(item.amountMinorUnits), item.currency)}`
      .toLowerCase()
      .includes(query.toLowerCase());
  const matchesTab =
    (tab === "all" && item.status !== "removed") ||
    (tab === "review" &&
      item.status !== "removed" &&
      (item.needsReview || hasSuggestedMatch(item))) ||
    (tab === "removed" && item.status === "removed");
  const absoluteAmount = Math.abs(Number(item.amountMinorUnits)) / 100;
  const minimum = Number(range.minimum);
  const maximum = Number(range.maximum);
  const effectiveDay = item.effectiveDate.slice(0, 10);
  const matchesRange =
    (!range.minimum || absoluteAmount >= minimum) &&
    (!range.maximum || absoluteAmount <= maximum) &&
    (!range.fromDate || effectiveDay >= range.fromDate) &&
    (!range.toDate || effectiveDay <= range.toDate);
  const selectedStatuses = filters.filter((filter) =>
    ["Needs review", "Suggested match", "Pending", "Posted", "Removed", "Excluded"].includes(
      filter,
    ),
  );
  const selectedTypes = filters.filter((filter) =>
    ["Income", "Expense", "Transfer", "Refund", "Recurring"].includes(filter),
  );
  const selectedSources = filters.filter((filter) =>
    ["SimpleFIN", "Manual", "CSV import"].includes(filter),
  );
  const matchesStatus =
    !selectedStatuses.length ||
    selectedStatuses.some(
      (filter) =>
        (filter === "Needs review" && item.needsReview) ||
        (filter === "Suggested match" && hasSuggestedMatch(item)) ||
        (filter === "Pending" && item.status === "pending") ||
        (filter === "Posted" && item.status === "posted") ||
        (filter === "Removed" && item.status === "removed") ||
        (filter === "Excluded" && Boolean(item.excluded)),
    );
  const matchesType =
    !selectedTypes.length ||
    selectedTypes.some(
      (filter) =>
        (filter === "Income" && item.isIncome) ||
        (filter === "Expense" && BigInt(item.amountMinorUnits) < 0n && !item.isTransfer) ||
        (filter === "Transfer" && item.isTransfer) ||
        (filter === "Refund" && item.refundLinkIds.length > 0) ||
        (filter === "Recurring" && Boolean(item.recurring)),
    );
  const matchesSource =
    !selectedSources.length ||
    selectedSources.some(
      (filter) =>
        (filter === "SimpleFIN" && item.source === "simplefin") ||
        (filter === "Manual" && item.source === "manual") ||
        (filter === "CSV import" && item.source === "import"),
    );
  return (
    matchesSearch && matchesTab && matchesStatus && matchesType && matchesSource && matchesRange
  );
}

function FilterContent({
  selected,
  setSelected,
  range,
  setRange,
}: {
  selected: string[];
  setSelected: (filters: string[]) => void;
  range: LedgerRangeFilters;
  setRange: (filters: LedgerRangeFilters) => void;
}) {
  const groups = [
    ["Status", ["Needs review", "Suggested match", "Pending", "Posted", "Removed", "Excluded"]],
    ["Type", ["Income", "Expense", "Transfer", "Refund", "Recurring"]],
    ["Source", ["SimpleFIN", "Manual", "CSV import"]],
  ];
  const toggle = (value: string) =>
    setSelected(
      selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value],
    );
  return (
    <Stack gap={5}>
      {groups.map(([label, values]) => (
        <Box key={String(label)}>
          <Typography variant="overline" color="text.secondary">
            {label}
          </Typography>
          <Stack direction="row" flexWrap="wrap" gap={2} sx={{ mt: 2 }}>
            {(values as string[]).map((value) => (
              <Chip
                key={value}
                clickable
                label={value}
                color={selected.includes(value) ? "primary" : "default"}
                variant={selected.includes(value) ? "filled" : "outlined"}
                onClick={() => toggle(value)}
              />
            ))}
          </Stack>
        </Box>
      ))}
      <Box>
        <Typography variant="overline" color="text.secondary">
          Absolute amount
        </Typography>
        <Stack direction="row" gap={2} sx={{ mt: 2 }}>
          <TextField
            label="Minimum"
            type="number"
            value={range.minimum}
            onChange={(event) => setRange({ ...range, minimum: event.target.value })}
            inputProps={{ min: 0, step: "0.01" }}
            InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
          />
          <TextField
            label="Maximum"
            type="number"
            value={range.maximum}
            onChange={(event) => setRange({ ...range, maximum: event.target.value })}
            inputProps={{ min: 0, step: "0.01" }}
            InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
          />
        </Stack>
      </Box>
      <Box>
        <Typography variant="overline" color="text.secondary">
          Effective date
        </Typography>
        <Stack direction="row" gap={2} sx={{ mt: 2 }}>
          <TextField
            label="From"
            type="date"
            value={range.fromDate}
            onChange={(event) => setRange({ ...range, fromDate: event.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            label="To"
            type="date"
            value={range.toDate}
            onChange={(event) => setRange({ ...range, toDate: event.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
          />
        </Stack>
      </Box>
    </Stack>
  );
}

function TransactionBadges({ item }: { item: TransactionView }) {
  const confirmedTransfer = item.transferMatch
    ? item.transferMatch.status === "confirmed"
    : item.isTransfer;
  const suggestedTransfer = item.transferMatch?.status === "suggested";
  const confirmedRefund = item.refundLinkMatches.some(({ status }) => status === "confirmed");
  const suggestedRefund = item.refundLinkMatches.some(({ status }) => status === "suggested");
  return (
    <Stack direction="row" justifyContent="flex-end" gap={1} flexWrap="wrap">
      {item.status === "removed" ? <StatusChip label="Removed" tone="neutral" /> : null}
      {item.status === "void" ? <StatusChip label="Void" tone="neutral" /> : null}
      {item.pending ? <StatusChip label="Pending" tone="warning" /> : null}
      {item.needsReview ? <StatusChip label="Review" tone="warning" /> : null}
      {confirmedTransfer ? <StatusChip label="Transfer" tone="neutral" /> : null}
      {suggestedTransfer ? <StatusChip label="Transfer suggestion" tone="warning" /> : null}
      {item.hasSplits ? <StatusChip label="Split" tone="info" /> : null}
      {confirmedRefund ? <StatusChip label="Refund" tone="positive" /> : null}
      {suggestedRefund ? <StatusChip label="Refund suggestion" tone="warning" /> : null}
      {item.excluded && !item.isTransfer ? <StatusChip label="Excluded" tone="neutral" /> : null}
    </Stack>
  );
}

function TransactionRow({
  item,
  checked,
  onCheck,
  onOpen,
}: {
  item: TransactionView;
  checked: boolean;
  onCheck: (checked: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns:
          "44px minmax(210px, 1.7fr) minmax(135px, .85fr) minmax(130px, .8fr) minmax(120px, .72fr)",
        gap: 2,
        alignItems: "center",
        minHeight: 68,
        px: 3,
        borderBottom: "1px solid",
        borderColor: "divider",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      {item.status === "removed" ? (
        <RemoveCircleOutlineRounded color="disabled" aria-label="Removed transaction" />
      ) : (
        <Checkbox
          size="small"
          checked={checked}
          onChange={(event) => onCheck(event.target.checked)}
          inputProps={{ "aria-label": `Select ${item.merchant}` }}
        />
      )}
      <Button
        color="inherit"
        onClick={onOpen}
        sx={{ justifyContent: "flex-start", textAlign: "left", p: 0, minHeight: 44, minWidth: 0 }}
      >
        <Box
          sx={{
            width: 38,
            height: 38,
            borderRadius: 2.5,
            flex: "0 0 auto",
            display: "grid",
            placeItems: "center",
            bgcolor:
              item.needsReview || hasSuggestedMatch(item) ? alpha("#D98B2B", 0.12) : "action.hover",
            color: item.needsReview || hasSuggestedMatch(item) ? "warning.main" : "text.secondary",
            mr: 2.5,
          }}
        >
          {item.needsReview || hasSuggestedMatch(item) ? (
            <WarningAmberRounded fontSize="small" />
          ) : (
            <ReceiptLongRounded fontSize="small" />
          )}
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={700} noWrap>
            {item.merchant}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {item.rawDescription}
          </Typography>
        </Box>
      </Button>
      <Box>
        <Typography variant="body2" noWrap>
          {item.hasSplits ? "Split transaction" : item.category}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap>
          {item.envelope}
        </Typography>
      </Box>
      <Box>
        <Typography variant="body2" noWrap>
          {item.account}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          ••{item.accountMask.slice(-2)}
        </Typography>
      </Box>
      <Box sx={{ textAlign: "right" }}>
        <Typography variant="body2" fontWeight={760}>
          <Money value={item.amount} sign />
        </Typography>
        <TransactionBadges item={item} />
      </Box>
    </Box>
  );
}

function MobileTransactionRow({
  item,
  checked,
  onCheck,
  onOpen,
}: {
  item: TransactionView;
  checked: boolean;
  onCheck: (checked: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
      <Stack direction="row" gap={2} alignItems="flex-start">
        {item.status === "removed" ? (
          <RemoveCircleOutlineRounded color="disabled" aria-label="Removed transaction" />
        ) : (
          <Checkbox
            size="small"
            checked={checked}
            onChange={(event) => onCheck(event.target.checked)}
            inputProps={{ "aria-label": `Select ${item.merchant}` }}
            sx={{ mt: -1, ml: -1 }}
          />
        )}
        <Button
          color="inherit"
          fullWidth
          onClick={onOpen}
          sx={{
            p: 0,
            minWidth: 0,
            minHeight: 44,
            justifyContent: "space-between",
            textAlign: "left",
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" fontWeight={720} noWrap>
              {item.merchant}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
              {item.hasSplits ? "Split transaction" : item.category} · {item.account}
            </Typography>
            <Box sx={{ mt: 1 }}>
              <TransactionBadges item={item} />
            </Box>
          </Box>
          <Typography variant="body2" fontWeight={760} sx={{ ml: 2 }}>
            <Money value={item.amount} sign />
          </Typography>
        </Button>
      </Stack>
    </Paper>
  );
}

function DialogHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <Box>
      <Typography variant="overline" color="primary.main">
        {eyebrow}
      </Typography>
      <Typography variant="h3" sx={{ mt: 0.5 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        {description}
      </Typography>
    </Box>
  );
}

function localDateTimeValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function ManualTransactionDialog({
  open,
  accounts,
  categories,
  onClose,
  onSubmit,
}: {
  open: boolean;
  accounts: ApiAccount[];
  categories: ApiCategory[];
  onClose: () => void;
  onSubmit: (input: {
    accountId: string;
    amountMinorUnits: string;
    currency: string;
    effectiveDate: string;
    description: string;
    categoryId?: string;
    note?: string;
  }) => Promise<void>;
}) {
  const [accountId, setAccountId] = useState("");
  const [direction, setDirection] = useState<"expense" | "income">("expense");
  const [amount, setAmount] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(localDateTimeValue());
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setAccountId(accounts[0]?.id ?? "");
    setDirection("expense");
    setAmount("");
    setEffectiveDate(localDateTimeValue());
    setDescription("");
    setCategoryId("");
    setNote("");
    setError("");
  }, [accounts, open]);

  const parsedAmount = parsePositiveCurrencyMinorUnits(amount);
  const account = accounts.find(({ id }) => id === accountId);
  const canSave = Boolean(account && parsedAmount && description.trim() && effectiveDate);
  const submit = async () => {
    if (!account || !parsedAmount || !description.trim()) return;
    setSaving(true);
    setError("");
    try {
      await onSubmit({
        accountId: account.id,
        amountMinorUnits: (direction === "expense" ? -parsedAmount : parsedAmount).toString(),
        currency: account.balance.currency,
        effectiveDate: new Date(effectiveDate).toISOString(),
        description: description.trim(),
        ...(categoryId ? { categoryId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The transaction could not be added.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle component="div">
        <DialogHeading
          eyebrow="Manual ledger entry"
          title="Add a transaction"
          description="Use this for cash, reimbursements, or anything your connected accounts do not provide."
        />
      </DialogTitle>
      <DialogContent>
        <Stack gap={3}>
          {!accounts.length ? (
            <Alert severity="warning">Add an account before creating a manual transaction.</Alert>
          ) : null}
          <TextField
            select
            label="Account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            fullWidth
          >
            {accounts.map((option) => (
              <MenuItem key={option.id} value={option.id}>
                {option.name} · ••{option.mask.slice(-2)}
              </MenuItem>
            ))}
          </TextField>
          <Stack direction={{ xs: "column", sm: "row" }} gap={2}>
            <TextField
              select
              label="Type"
              value={direction}
              onChange={(event) => setDirection(event.target.value as "expense" | "income")}
              sx={{ minWidth: 150 }}
            >
              <MenuItem value="expense">Expense</MenuItem>
              <MenuItem value="income">Income / credit</MenuItem>
            </TextField>
            <TextField
              label="Amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
              helperText="Enter a positive amount; the selected type sets its direction."
              fullWidth
            />
          </Stack>
          <TextField
            label="Date and time"
            type="datetime-local"
            value={effectiveDate}
            onChange={(event) => setEffectiveDate(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
            fullWidth
          />
          <TextField
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Coffee shop, cash rent, reimbursement…"
            fullWidth
          />
          <TextField
            select
            label="Category (optional)"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            fullWidth
          >
            <MenuItem value="">Leave for review</MenuItem>
            {categories
              .filter(
                ({ active, kind }) =>
                  active && (direction === "income" ? kind === "income" : kind === "expense"),
              )
              .map((category) => (
                <MenuItem key={category.id} value={category.id}>
                  {category.name}
                </MenuItem>
              ))}
          </TextField>
          <TextField
            label="Note (optional)"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            multiline
            minRows={2}
            fullWidth
          />
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!canSave || saving} onClick={() => void submit()}>
          {saving ? "Adding…" : "Add transaction"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function estimatedImportRecords(filename: string, content: string) {
  if (filename.toLowerCase().endsWith(".csv")) {
    return Math.max(0, content.split(/\r?\n/).filter((line) => line.trim()).length - 1);
  }
  return content.match(/<STMTTRN>/gi)?.length ?? 0;
}

export function ImportTransactionsDialog({
  open,
  accounts,
  onClose,
  onSubmit,
}: {
  open: boolean;
  accounts: ApiAccount[];
  onClose: () => void;
  onSubmit: (input: {
    accountId: string;
    filename: string;
    content: string;
    currency: string;
  }) => Promise<ApiTransactionImportResult>;
}) {
  const [accountId, setAccountId] = useState("");
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ApiTransactionImportResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setAccountId(accounts[0]?.id ?? "");
    setFilename("");
    setContent("");
    setError("");
    setResult(null);
  }, [accounts, open]);

  const account = accounts.find(({ id }) => id === accountId);
  const estimate = filename && content ? estimatedImportRecords(filename, content) : 0;
  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    setError("");
    setResult(null);
    try {
      if (!/\.(csv|ofx|qfx)$/i.test(file.name)) {
        throw new Error("Choose a CSV, OFX, or QFX transaction file.");
      }
      if (file.size > 10 * 1024 * 1024)
        throw new Error("The import file must be 10 MB or smaller.");
      setFilename(file.name);
      setContent(await file.text());
    } catch (caught) {
      setFilename("");
      setContent("");
      setError(caught instanceof Error ? caught.message : "The file could not be read.");
    } finally {
      setReading(false);
    }
  };
  const submit = async () => {
    if (!account || !filename || !content) return;
    setSaving(true);
    setError("");
    try {
      setResult(
        await onSubmit({
          accountId: account.id,
          filename,
          content,
          currency: account.balance.currency,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The file could not be imported.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle component="div">
        <DialogHeading
          eyebrow="Local file import"
          title="Import transactions"
          description="CSV, OFX, and QFX files are parsed by your self-hosted API. Existing IDs and fingerprints are deduplicated."
        />
      </DialogTitle>
      <DialogContent>
        <Stack gap={3}>
          {!accounts.length ? (
            <Alert severity="warning">Add an account before importing its transactions.</Alert>
          ) : null}
          <TextField
            select
            label="Import into account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            fullWidth
            disabled={Boolean(result)}
          >
            {accounts.map((option) => (
              <MenuItem key={option.id} value={option.id}>
                {option.name} · {option.balance.currency}
              </MenuItem>
            ))}
          </TextField>
          <Paper
            variant="outlined"
            sx={{
              p: 4,
              borderRadius: 3,
              borderStyle: "dashed",
              textAlign: "center",
              bgcolor: "action.hover",
            }}
          >
            <UploadFileRounded color="action" sx={{ fontSize: 34 }} />
            <Typography variant="body2" fontWeight={750} sx={{ mt: 1 }}>
              {filename || "Choose a bank export"}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
              {filename
                ? `${estimate} estimated transaction rows · ${(new Blob([content]).size / 1024).toFixed(1)} KB`
                : "Up to 10 MB · .csv, .ofx, or .qfx"}
            </Typography>
            <Button
              component="label"
              variant="outlined"
              disabled={reading || Boolean(result)}
              sx={{ mt: 3 }}
            >
              {reading ? "Reading file…" : filename ? "Choose another file" : "Choose file"}
              <input
                hidden
                type="file"
                accept=".csv,.ofx,.qfx,text/csv,application/x-ofx"
                aria-label="Transaction import file"
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
            </Button>
          </Paper>
          {filename && !result ? (
            <Alert severity="info">
              Review the account and file summary. Import commits accepted rows immediately and
              keeps an encrypted raw audit record.
            </Alert>
          ) : null}
          {result ? (
            <Alert severity="success">
              <strong>{result.importedRecords} imported</strong> · {result.duplicateRecords}{" "}
              duplicates skipped · {result.rejectedRecords} rejected · {result.totalRecords} total
            </Alert>
          ) : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          {result ? "Done" : "Cancel"}
        </Button>
        {!result ? (
          <Button
            variant="contained"
            disabled={!account || !content || saving || reading}
            onClick={() => void submit()}
          >
            {saving ? "Importing…" : `Import ${estimate || "file"}`}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}

interface SplitRowDraft {
  key: number;
  amount: string;
  categoryId: string;
  envelopeId: string;
  memo: string;
}

function initialSplitRows(item: TransactionView, detail?: ApiTransactionDetail): SplitRowDraft[] {
  if (detail?.splits.length) {
    return detail.splits.map((split, index) => ({
      key: index,
      amount: minorUnitsToInput(BigInt(split.amount.minorUnits)),
      categoryId: split.categoryId ?? "",
      envelopeId: split.envelopeId ?? "",
      memo: split.memo ?? "",
    }));
  }
  const absolute =
    BigInt(item.amountMinorUnits) < 0n
      ? -BigInt(item.amountMinorUnits)
      : BigInt(item.amountMinorUnits);
  const first = absolute / 2n;
  const second = absolute - first;
  return [
    { key: 0, amount: minorUnitsToInput(first), categoryId: "", envelopeId: "", memo: "" },
    { key: 1, amount: minorUnitsToInput(second), categoryId: "", envelopeId: "", memo: "" },
  ];
}

export function SplitTransactionDialog({
  open,
  item,
  detail,
  categories,
  envelopes,
  onClose,
  onSubmit,
}: {
  open: boolean;
  item: TransactionView | null;
  detail: ApiTransactionDetail | undefined;
  categories: ApiCategory[];
  envelopes: ApiEnvelope[];
  onClose: () => void;
  onSubmit: (splits: SplitDraft[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<SplitRowDraft[]>([]);
  const [nextKey, setNextKey] = useState(2);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !item) return;
    const initial = initialSplitRows(item, detail);
    setRows(initial);
    setNextKey(Math.max(2, ...initial.map(({ key }) => key + 1)));
    setError("");
  }, [detail, item, open]);

  if (!item) return null;
  const total =
    BigInt(item.amountMinorUnits) < 0n
      ? -BigInt(item.amountMinorUnits)
      : BigInt(item.amountMinorUnits);
  const parsed = rows.map(({ amount }) => parsePositiveCurrencyMinorUnits(amount));
  const parsedTotal = parsed.reduce<bigint>((sum, amount) => sum + (amount ?? 0n), 0n);
  const exact = parsed.every((amount) => amount !== null) && parsedTotal === total;
  const difference = total - parsedTotal;
  const validationMessage = parsed.some((amount) => amount === null)
    ? "Enter a positive amount with no more than two decimal places for every split."
    : difference === 0n
      ? "Every cent is assigned."
      : difference > 0n
        ? `${formatMinorUnits(difference, item.currency)} still needs a category.`
        : `${formatMinorUnits(-difference, item.currency)} is assigned too much.`;

  const updateRow = (key: number, patch: Partial<SplitRowDraft>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setError("");
  };
  const submit = async () => {
    if (!exact) return;
    setSaving(true);
    setError("");
    try {
      const negative = BigInt(item.amountMinorUnits) < 0n;
      await onSubmit(
        rows.map((row, index) => {
          const amount = parsed[index];
          if (amount == null) throw new Error("Every split needs a valid amount.");
          return {
            amountMinorUnits: (negative ? -amount : amount).toString(),
            ...(row.categoryId ? { categoryId: row.categoryId } : {}),
            ...(row.envelopeId ? { envelopeId: row.envelopeId } : {}),
            ...(row.memo.trim() ? { memo: row.memo.trim() } : {}),
          };
        }),
      );
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The split could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle component="div">
        <DialogHeading
          eyebrow="Exact allocation"
          title={detail?.splits.length ? "Edit transaction split" : "Split transaction"}
          description={`${item.merchant} · ${formatMinorUnits(BigInt(item.amountMinorUnits), item.currency)}`}
        />
      </DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 4 }}>
          Split amounts must equal the original transaction exactly. Reports use these parts instead
          of double-counting the parent.
        </Alert>
        <Stack gap={3}>
          {rows.map((row, index) => (
            <Paper key={row.key} variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
              <Stack
                direction={{ xs: "column", md: "row" }}
                gap={2}
                alignItems={{ xs: "stretch", md: "flex-start" }}
              >
                <TextField
                  label={`Split ${index + 1} amount`}
                  value={row.amount}
                  onChange={(event) => updateRow(row.key, { amount: event.target.value })}
                  inputMode="decimal"
                  InputProps={{
                    startAdornment: <InputAdornment position="start">$</InputAdornment>,
                  }}
                  sx={{ minWidth: 145 }}
                />
                <TextField
                  select
                  label={`Split ${index + 1} category`}
                  value={row.categoryId}
                  onChange={(event) => updateRow(row.key, { categoryId: event.target.value })}
                  sx={{ minWidth: 180, flex: 1 }}
                >
                  <MenuItem value="">No category</MenuItem>
                  {categories
                    .filter(({ active }) => active)
                    .map((category) => (
                      <MenuItem key={category.id} value={category.id}>
                        {category.name}
                      </MenuItem>
                    ))}
                </TextField>
                <TextField
                  select
                  label={`Split ${index + 1} envelope`}
                  value={row.envelopeId}
                  onChange={(event) => updateRow(row.key, { envelopeId: event.target.value })}
                  sx={{ minWidth: 180, flex: 1 }}
                >
                  <MenuItem value="">No envelope</MenuItem>
                  {envelopes.map((envelope) => (
                    <MenuItem key={envelope.id} value={envelope.id}>
                      {envelope.name}
                    </MenuItem>
                  ))}
                </TextField>
                <Tooltip
                  title={rows.length <= 2 ? "A split needs at least two parts" : "Remove part"}
                >
                  <span>
                    <IconButton
                      disabled={rows.length <= 2}
                      aria-label={`Remove split ${index + 1}`}
                      onClick={() =>
                        setRows((current) => current.filter(({ key }) => key !== row.key))
                      }
                    >
                      <RemoveCircleOutlineRounded />
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
              <TextField
                label={`Split ${index + 1} memo (optional)`}
                value={row.memo}
                onChange={(event) => updateRow(row.key, { memo: event.target.value })}
                fullWidth
                sx={{ mt: 2 }}
              />
            </Paper>
          ))}
        </Stack>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          justifyContent="space-between"
          gap={2}
          sx={{ mt: 3 }}
        >
          <Button
            startIcon={<AddRounded />}
            onClick={() => {
              setRows((current) => [
                ...current,
                { key: nextKey, amount: "0.00", categoryId: "", envelopeId: "", memo: "" },
              ]);
              setNextKey((current) => current + 1);
            }}
          >
            Add another part
          </Button>
          <Alert severity={exact ? "success" : "warning"} sx={{ py: 0 }}>
            {validationMessage}
          </Alert>
        </Stack>
        {error ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {error}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!exact || saving} onClick={() => void submit()}>
          {saving ? "Saving split…" : detail?.splits.length ? "Update split" : "Save split"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function MatchTransferDialog({
  open,
  item,
  transactions,
  onClose,
  onSubmit,
}: {
  open: boolean;
  item: TransactionView | null;
  transactions: TransactionView[];
  onClose: () => void;
  onSubmit: (input: { outflowTransactionId: string; inflowTransactionId: string }) => Promise<void>;
}) {
  const [candidateId, setCandidateId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const candidates = useMemo(() => {
    if (!item) return [];
    const currentAmount = BigInt(item.amountMinorUnits);
    return transactions.filter(
      (candidate) =>
        candidate.id !== item.id &&
        candidate.currency === item.currency &&
        BigInt(candidate.amountMinorUnits) === -currentAmount &&
        candidate.accountId !== item.accountId &&
        !candidate.transferId,
    );
  }, [item, transactions]);

  useEffect(() => {
    if (!open) return;
    setCandidateId(candidates.length === 1 ? (candidates[0]?.id ?? "") : "");
    setError("");
  }, [candidates, open]);

  if (!item) return null;
  const selected = candidates.find(({ id }) => id === candidateId);
  const submit = async () => {
    if (!selected) return;
    const currentIsOutflow = BigInt(item.amountMinorUnits) < 0n;
    setSaving(true);
    setError("");
    try {
      await onSubmit({
        outflowTransactionId: currentIsOutflow ? item.id : selected.id,
        inflowTransactionId: currentIsOutflow ? selected.id : item.id,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The transfer could not be matched.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle component="div">
        <DialogHeading
          eyebrow="Cash flow cleanup"
          title="Match both sides of a transfer"
          description="Matched transfers stay visible but leave spending and income reports."
        />
      </DialogTitle>
      <DialogContent>
        <Paper variant="outlined" sx={{ p: 3, borderRadius: 3, mb: 3 }}>
          <Typography variant="caption" color="text.secondary">
            Selected {directionLabel(item)}
          </Typography>
          <Typography variant="body2" fontWeight={750} sx={{ mt: 1 }}>
            {candidateLabel(item)}
          </Typography>
        </Paper>
        {candidates.length ? (
          <TextField
            select
            fullWidth
            label="Matching transaction"
            value={candidateId}
            onChange={(event) => setCandidateId(event.target.value)}
            helperText="Only an exact, opposite amount in the same currency and a different account can match."
          >
            <MenuItem value="">Choose the other side</MenuItem>
            {candidates.map((candidate) => (
              <MenuItem key={candidate.id} value={candidate.id}>
                {candidateLabel(candidate)}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <Alert severity="info">
            No unmatched exact opposite was found. Sync the receiving account, then try again.
          </Alert>
        )}
        {selected ? (
          <Alert severity="success" sx={{ mt: 3 }}>
            Exact{" "}
            {formatMinorUnits(
              BigInt(item.amountMinorUnits) < 0n
                ? -BigInt(item.amountMinorUnits)
                : BigInt(item.amountMinorUnits),
              item.currency,
            )}{" "}
            pair found. Both entries will be excluded from spending.
          </Alert>
        ) : null}
        {error ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {error}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!selected || saving} onClick={() => void submit()}>
          {saving ? "Matching…" : "Confirm transfer match"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function LinkRefundDialog({
  open,
  item,
  transactions,
  onClose,
  onSubmit,
}: {
  open: boolean;
  item: TransactionView | null;
  transactions: TransactionView[];
  onClose: () => void;
  onSubmit: (input: {
    refundTransactionId: string;
    purchaseTransactionId: string;
  }) => Promise<void>;
}) {
  const [candidateId, setCandidateId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const candidates = useMemo(() => {
    if (!item) return [];
    const current = BigInt(item.amountMinorUnits);
    return transactions.filter((candidate) => {
      const other = BigInt(candidate.amountMinorUnits);
      if (
        candidate.id === item.id ||
        candidate.accountId !== item.accountId ||
        candidate.currency !== item.currency ||
        candidate.isTransfer ||
        (current < 0n ? other <= 0n : other >= 0n)
      )
        return false;
      return current < 0n ? other <= -current : -other >= current;
    });
  }, [item, transactions]);

  useEffect(() => {
    if (!open) return;
    setCandidateId(candidates.length === 1 ? (candidates[0]?.id ?? "") : "");
    setError("");
  }, [candidates, open]);

  if (!item) return null;
  const selected = candidates.find(({ id }) => id === candidateId);
  const submit = async () => {
    if (!selected) return;
    const currentIsRefund = BigInt(item.amountMinorUnits) > 0n;
    setSaving(true);
    setError("");
    try {
      await onSubmit({
        refundTransactionId: currentIsRefund ? item.id : selected.id,
        purchaseTransactionId: currentIsRefund ? selected.id : item.id,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The refund could not be linked.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle component="div">
        <DialogHeading
          eyebrow="Net spending accuracy"
          title={
            BigInt(item.amountMinorUnits) > 0n
              ? "Link this refund"
              : "Find a refund for this purchase"
          }
          description="The refund inherits the purchase category so your budget reflects what you actually kept."
        />
      </DialogTitle>
      <DialogContent>
        <Paper variant="outlined" sx={{ p: 3, borderRadius: 3, mb: 3 }}>
          <Typography variant="caption" color="text.secondary">
            Selected {directionLabel(item)}
          </Typography>
          <Typography variant="body2" fontWeight={750} sx={{ mt: 1 }}>
            {candidateLabel(item)}
          </Typography>
        </Paper>
        {candidates.length ? (
          <TextField
            select
            fullWidth
            label={BigInt(item.amountMinorUnits) > 0n ? "Original purchase" : "Refund credit"}
            value={candidateId}
            onChange={(event) => setCandidateId(event.target.value)}
            helperText="Candidates use the same account and currency, opposite direction, and enough unlinked value."
          >
            <MenuItem value="">Choose a transaction</MenuItem>
            {candidates.map((candidate) => (
              <MenuItem key={candidate.id} value={candidate.id}>
                {candidateLabel(candidate)}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <Alert severity="info">No eligible purchase or credit is in the loaded ledger.</Alert>
        )}
        {selected ? (
          <Alert severity="info" sx={{ mt: 3 }}>
            BetterWealth will link only the still-unlinked amount, capped by both sides.
          </Alert>
        ) : null}
        {error ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {error}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!selected || saving} onClick={() => void submit()}>
          {saving ? "Linking…" : "Confirm refund link"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function CreateTransactionRuleDialog({
  open,
  item,
  detail,
  categories,
  onClose,
  onPreview,
  onSubmit,
}: {
  open: boolean;
  item: TransactionView | null;
  detail: ApiTransactionDetail | undefined;
  categories: ApiCategory[];
  onClose: () => void;
  onPreview: (input: Pick<ApiRule, "conditions" | "actions">) => Promise<RulePreview>;
  onSubmit: (input: RuleCreateInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const [operator, setOperator] = useState<"exact" | "contains">("exact");
  const [categoryId, setCategoryId] = useState("");
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [working, setWorking] = useState<"preview" | "save" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !item) return;
    setName(`${item.merchant} → ${item.category}`);
    setPattern(item.rawDescription);
    setOperator("exact");
    setCategoryId(
      detail?.categoryId ?? categories.find(({ name }) => name === item.category)?.id ?? "",
    );
    setPreview(null);
    setError("");
  }, [categories, detail?.categoryId, item, open]);

  if (!item) return null;
  const condition = {
    field: "normalizedDescription",
    operator,
    value: pattern.trim(),
    caseSensitive: false,
  };
  const actions = categoryId ? [{ type: "setCategory", categoryId }] : [];
  const update = (callback: () => void) => {
    callback();
    setPreview(null);
    setError("");
  };
  const runPreview = async () => {
    if (!pattern.trim() || !categoryId) return;
    setWorking("preview");
    setError("");
    try {
      setPreview(await onPreview({ conditions: condition, actions }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The rule preview could not run.");
    } finally {
      setWorking(null);
    }
  };
  const save = async () => {
    if (!preview || !name.trim() || !pattern.trim() || !categoryId) return;
    setWorking("save");
    setError("");
    try {
      await onSubmit({
        name: name.trim(),
        priority: 100,
        enabled: true,
        origin: "user",
        conditions: condition,
        actions,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The rule could not be created.");
    } finally {
      setWorking(null);
    }
  };

  return (
    <Dialog open={open} onClose={working ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle component="div">
        <DialogHeading
          eyebrow="Deterministic automation"
          title="Create a narrow transaction rule"
          description="Preview historical matches first. Saving the rule does not recategorize history."
        />
      </DialogTitle>
      <DialogContent>
        <Stack gap={3}>
          <TextField
            label="Rule name"
            value={name}
            onChange={(event) => update(() => setName(event.target.value))}
            fullWidth
          />
          <Paper variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
            <Typography variant="overline" color="text.secondary">
              When
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} gap={2} sx={{ mt: 2 }}>
              <TextField
                select
                label="Description match"
                value={operator}
                onChange={(event) =>
                  update(() => setOperator(event.target.value as "exact" | "contains"))
                }
                sx={{ minWidth: 150 }}
              >
                <MenuItem value="exact">is exactly</MenuItem>
                <MenuItem value="contains">contains</MenuItem>
              </TextField>
              <TextField
                label="Normalized description pattern"
                value={pattern}
                onChange={(event) => update(() => setPattern(event.target.value))}
                fullWidth
              />
            </Stack>
            {operator === "contains" ? (
              <Alert severity="warning" sx={{ mt: 2 }}>
                Contains rules are broader. Keep this provider-specific text distinctive.
              </Alert>
            ) : null}
          </Paper>
          <Paper variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
            <Typography variant="overline" color="text.secondary">
              Then
            </Typography>
            <TextField
              select
              label="Set category"
              value={categoryId}
              onChange={(event) => update(() => setCategoryId(event.target.value))}
              fullWidth
              sx={{ mt: 2 }}
            >
              <MenuItem value="">Choose a category</MenuItem>
              {categories
                .filter(({ active, kind }) => active && kind !== "transfer")
                .map((category) => (
                  <MenuItem key={category.id} value={category.id}>
                    {category.name}
                  </MenuItem>
                ))}
            </TextField>
          </Paper>
          <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
            <Box>
              <Typography variant="body2" fontWeight={750}>
                Preview before saving
              </Typography>
              <Typography variant="caption" color="text.secondary">
                No transaction changes during preview.
              </Typography>
            </Box>
            <Button
              variant="outlined"
              disabled={!pattern.trim() || !categoryId || Boolean(working)}
              onClick={() => void runPreview()}
            >
              {working === "preview" ? "Checking…" : "Run preview"}
            </Button>
          </Stack>
          {preview ? (
            <Alert severity={preview.conflicts.length ? "warning" : "success"}>
              <strong>
                {preview.matchCount} historical {preview.matchCount === 1 ? "match" : "matches"}
              </strong>
              {` · ${formatMinorUnits(BigInt(preview.aggregateAmount.minorUnits), preview.aggregateAmount.currency)}`}
              {preview.conflicts.length
                ? ` · ${preview.conflicts.length} existing rule conflict${preview.conflicts.length === 1 ? "" : "s"}`
                : " · no existing rule conflicts"}
            </Alert>
          ) : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={Boolean(working)}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={!preview || !name.trim() || Boolean(working)}
          onClick={() => void save()}
        >
          {working === "save" ? "Creating rule…" : "Confirm and create rule"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function TransactionDetail({
  item,
  details,
  transactions,
  detailLoading,
  detailError,
  categories,
  open,
  onClose,
  onSave,
  onSaveTags,
  onRemove,
  onRestore,
  onAction,
  onConfirmTransferSuggestion,
  onRejectTransferSuggestion,
  onConfirmRefundSuggestion,
  onRejectRefundSuggestion,
  saving,
  saveError,
}: {
  item: TransactionView | null;
  details: ApiTransactionDetail | undefined;
  transactions: TransactionView[];
  detailLoading: boolean;
  detailError: string | null;
  categories: ApiCategory[];
  open: boolean;
  onClose: () => void;
  onSave: (item: TransactionView, patch: Partial<ApiTransaction>) => Promise<void>;
  onSaveTags: (item: TransactionView, tags: string[]) => Promise<void>;
  onRemove: (item: TransactionView) => Promise<void>;
  onRestore: (item: TransactionView) => Promise<void>;
  onAction: (action: TransactionAction) => void;
  onConfirmTransferSuggestion: (match: ApiTransferMatch) => Promise<void>;
  onRejectTransferSuggestion: (id: string) => Promise<void>;
  onConfirmRefundSuggestion: (match: ApiRefundLinkMatch) => Promise<void>;
  onRejectRefundSuggestion: (id: string) => Promise<void>;
  saving: boolean;
  saveError: string | null;
}) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const [merchant, setMerchant] = useState(item?.merchant ?? "");
  const [category, setCategory] = useState(item?.category ?? "Uncategorized");
  const [note, setNote] = useState(item?.note ?? "");
  const [excluded, setExcluded] = useState(Boolean(item?.excluded));
  const [tagDraft, setTagDraft] = useState<string[]>(item?.tags ?? []);
  const [newTag, setNewTag] = useState("");
  const [saved, setSaved] = useState(false);
  const [reviewingMatch, setReviewingMatch] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [removeOpen, setRemoveOpen] = useState(false);
  const [statusWorking, setStatusWorking] = useState<"remove" | "restore" | "">("");
  const [statusError, setStatusError] = useState("");

  useEffect(() => {
    setMerchant(item?.merchant ?? "");
    setCategory(item?.category ?? "Uncategorized");
    setNote(item?.note ?? "");
    setExcluded(Boolean(item?.excluded));
    setTagDraft(item?.tags ?? []);
    setNewTag("");
    setSaved(false);
    setReviewingMatch("");
    setReviewError("");
    setRemoveOpen(false);
    setStatusWorking("");
    setStatusError("");
  }, [item]);

  useEffect(() => {
    if (details?.tags) setTagDraft(details.tags);
  }, [details?.tags]);

  if (!item) return null;
  const save = async () => {
    await onSave(item, { merchant, categoryName: category, note, isExcluded: excluded });
    const originalTags = details?.tags ?? item.tags;
    if (JSON.stringify(tagDraft) !== JSON.stringify(originalTags)) {
      await onSaveTags(item, tagDraft);
    }
    setSaved(true);
    window.setTimeout(onClose, 350);
  };
  const addTag = () => {
    const value = newTag.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (!value || value.length > 40 || tagDraft.length >= 20) return;
    if (tagDraft.some((tag) => tag.toLocaleLowerCase() === value.toLocaleLowerCase())) {
      setNewTag("");
      return;
    }
    setTagDraft((current) => [...current, value]);
    setNewTag("");
  };
  const changeStatus = async (action: "remove" | "restore") => {
    setStatusWorking(action);
    setStatusError("");
    try {
      if (action === "remove") await onRemove(item);
      else await onRestore(item);
      setRemoveOpen(false);
    } catch (caught) {
      setStatusError(
        caught instanceof Error ? caught.message : "The transaction status could not be changed.",
      );
    } finally {
      setStatusWorking("");
    }
  };
  const readOnly = item.status === "removed" || item.status === "void";
  const transferMatch = details?.transfer ?? item.transferMatch ?? null;
  const transferMatched = transferMatch
    ? transferMatch.status === "confirmed"
    : Boolean(item.isTransfer);
  const transferSuggested = transferMatch?.status === "suggested";
  const splitCount = details?.splits.length ?? (item.hasSplits ? 2 : 0);
  const refundMatches = details?.refundLinks ?? item.refundLinkMatches;
  const confirmedRefunds = refundMatches.filter(({ status }) => status === "confirmed");
  const suggestedRefunds = refundMatches.filter(({ status }) => status === "suggested");
  const itemMinorUnits = BigInt(item.amountMinorUnits);
  const absoluteItemMinorUnits = itemMinorUnits < 0n ? -itemMinorUnits : itemMinorUnits;
  const transferCounterpart = transferMatch
    ? transactions.find(
        ({ id }) =>
          id ===
          (transferMatch.outflowTransactionId === item.id
            ? transferMatch.inflowTransactionId
            : transferMatch.outflowTransactionId),
      )
    : undefined;
  const runMatchReview = async (key: string, action: () => Promise<void>) => {
    setReviewingMatch(key);
    setReviewError("");
    try {
      await action();
    } catch (caught) {
      setReviewError(
        caught instanceof Error ? caught.message : "The match review could not be saved.",
      );
    } finally {
      setReviewingMatch("");
    }
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{ sx: { width: mobile ? "100%" : 520, maxWidth: "100%", height: "100%" } }}
    >
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{ px: { xs: 4, sm: 5 }, py: 3, borderBottom: "1px solid", borderColor: "divider" }}
        >
          <Box>
            <Typography variant="caption" color="text.secondary">
              {item.date} · {item.account}
            </Typography>
            <Typography variant="h3" sx={{ mt: 0.5 }}>
              Transaction detail
            </Typography>
          </Box>
          <IconButton aria-label="Close transaction detail" onClick={onClose}>
            <CloseRounded />
          </IconButton>
        </Stack>
        <Box sx={{ px: { xs: 4, sm: 5 }, py: 5, overflowY: "auto", flex: 1 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={3}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary">
                Original description
              </Typography>
              <Typography variant="body2" fontWeight={700} sx={{ mt: 1, wordBreak: "break-word" }}>
                {item.rawDescription}
              </Typography>
            </Box>
            <Typography sx={{ fontSize: 24, fontWeight: 760 }}>
              <Money value={item.amount} sign />
            </Typography>
          </Stack>
          <Stack direction="row" gap={1.5} sx={{ mt: 3 }} flexWrap="wrap">
            {item.status === "removed" ? (
              <StatusChip label="Removed" tone="neutral" />
            ) : item.status === "void" ? (
              <StatusChip label="Void" tone="neutral" />
            ) : item.pending ? (
              <StatusChip label="Pending" tone="warning" />
            ) : (
              <StatusChip label="Posted" tone="positive" />
            )}
            {item.needsReview ? <StatusChip label="Needs review" tone="warning" /> : null}
            {item.recurring ? <StatusChip label="Recurring" tone="info" /> : null}
            {splitCount ? <StatusChip label={`${splitCount}-part split`} tone="info" /> : null}
            {transferMatched ? <StatusChip label="Matched transfer" tone="neutral" /> : null}
            {transferSuggested ? <StatusChip label="Transfer suggestion" tone="warning" /> : null}
            {confirmedRefunds.length ? (
              <StatusChip
                label={`${confirmedRefunds.length} refund ${confirmedRefunds.length === 1 ? "link" : "links"}`}
                tone="positive"
              />
            ) : null}
            {suggestedRefunds.length ? (
              <StatusChip
                label={`${suggestedRefunds.length} refund ${suggestedRefunds.length === 1 ? "suggestion" : "suggestions"}`}
                tone="warning"
              />
            ) : null}
          </Stack>
          {detailLoading ? (
            <Alert severity="info" sx={{ mt: 3 }}>
              Loading allocation details…
            </Alert>
          ) : null}
          {detailError ? (
            <Alert severity="warning" sx={{ mt: 3 }}>
              {detailError}
            </Alert>
          ) : null}
          {item.status === "removed" ? (
            <Alert severity="info" sx={{ mt: 3 }}>
              This entry is excluded from reports but its imported fact, tags, links, and audit
              history are intact. Restore it to edit or include it again.
            </Alert>
          ) : item.status === "void" ? (
            <Alert severity="info" sx={{ mt: 3 }}>
              This provider-voided entry is retained as read-only ledger history.
            </Alert>
          ) : null}
          {details?.splits.length ? (
            <Paper variant="outlined" sx={{ p: 3, borderRadius: 3, mt: 3 }}>
              <Typography variant="overline" color="text.secondary">
                Split allocation
              </Typography>
              <Stack gap={1.5} sx={{ mt: 2 }}>
                {details.splits.map((split) => (
                  <Stack key={split.id} direction="row" justifyContent="space-between" gap={2}>
                    <Typography variant="body2">
                      {split.categoryName ?? "Uncategorized"}
                      {split.envelopeName ? ` · ${split.envelopeName}` : ""}
                    </Typography>
                    <Typography variant="body2" fontWeight={750}>
                      {formatMinorUnits(BigInt(split.amount.minorUnits), split.amount.currency)}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Paper>
          ) : null}
          {!readOnly && transferSuggested && transferMatch ? (
            <Paper
              variant="outlined"
              aria-label="Suggested transfer match"
              sx={{ p: 3, borderRadius: 3, mt: 3, borderColor: "warning.main" }}
            >
              <Stack direction="row" justifyContent="space-between" gap={2} alignItems="center">
                <Box>
                  <Typography variant="overline" color="warning.main">
                    Suggested transfer match
                  </Typography>
                  <Typography variant="body2" fontWeight={750} sx={{ mt: 0.5 }}>
                    Exact {formatMinorUnits(absoluteItemMinorUnits, item.currency)} opposite entry
                  </Typography>
                </Box>
                <StatusChip label="Needs confirmation" tone="warning" />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                {transferCounterpart
                  ? `${transferCounterpart.merchant} · ${transferCounterpart.account} · ${transferCounterpart.date}`
                  : "The matching entry is outside the currently loaded ledger page."}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
                Evidence:{" "}
                {transferMatch.matchedBy === "provider"
                  ? "provider pairing metadata"
                  : "unique exact amount, currency, account, and date fingerprint"}
                . Nothing is excluded from reports until you confirm.
              </Typography>
              <Stack direction="row" justifyContent="flex-end" gap={2} sx={{ mt: 3 }}>
                <Button
                  color="inherit"
                  disabled={Boolean(reviewingMatch)}
                  onClick={() =>
                    void runMatchReview(`transfer:${transferMatch.id}:reject`, () =>
                      onRejectTransferSuggestion(transferMatch.id),
                    )
                  }
                >
                  Reject match
                </Button>
                <Button
                  variant="contained"
                  disabled={Boolean(reviewingMatch)}
                  onClick={() =>
                    void runMatchReview(`transfer:${transferMatch.id}:confirm`, () =>
                      onConfirmTransferSuggestion(transferMatch),
                    )
                  }
                >
                  {reviewingMatch === `transfer:${transferMatch.id}:confirm`
                    ? "Confirming…"
                    : "Confirm transfer"}
                </Button>
              </Stack>
            </Paper>
          ) : null}
          {!readOnly &&
            suggestedRefunds.map((match) => {
              const counterpartId =
                match.refundTransactionId === item.id
                  ? match.purchaseTransactionId
                  : match.refundTransactionId;
              const counterpart = transactions.find(({ id }) => id === counterpartId);
              return (
                <Paper
                  key={match.id}
                  variant="outlined"
                  aria-label="Suggested refund match"
                  sx={{ p: 3, borderRadius: 3, mt: 3, borderColor: "warning.main" }}
                >
                  <Stack direction="row" justifyContent="space-between" gap={2} alignItems="center">
                    <Box>
                      <Typography variant="overline" color="warning.main">
                        Suggested refund match
                      </Typography>
                      <Typography variant="body2" fontWeight={750} sx={{ mt: 0.5 }}>
                        Link{" "}
                        {formatMinorUnits(BigInt(match.amount.minorUnits), match.amount.currency)}{" "}
                        to the original purchase
                      </Typography>
                    </Box>
                    <StatusChip label="Needs confirmation" tone="warning" />
                  </Stack>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                    {counterpart
                      ? `${counterpart.merchant} · ${counterpart.account} · ${counterpart.date}`
                      : "The matching entry is outside the currently loaded ledger page."}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: "block", mt: 1 }}
                  >
                    Evidence: same account and currency, exact opposite amount, and merchant/date
                    context. Budgets change only after confirmation.
                  </Typography>
                  <Stack direction="row" justifyContent="flex-end" gap={2} sx={{ mt: 3 }}>
                    <Button
                      color="inherit"
                      disabled={Boolean(reviewingMatch)}
                      onClick={() =>
                        void runMatchReview(`refund:${match.id}:reject`, () =>
                          onRejectRefundSuggestion(match.id),
                        )
                      }
                    >
                      Reject match
                    </Button>
                    <Button
                      variant="contained"
                      disabled={Boolean(reviewingMatch)}
                      onClick={() =>
                        void runMatchReview(`refund:${match.id}:confirm`, () =>
                          onConfirmRefundSuggestion(match),
                        )
                      }
                    >
                      {reviewingMatch === `refund:${match.id}:confirm`
                        ? "Confirming…"
                        : "Confirm refund"}
                    </Button>
                  </Stack>
                </Paper>
              );
            })}
          {reviewError ? (
            <Alert severity="error" sx={{ mt: 3 }}>
              {reviewError}
            </Alert>
          ) : null}
          {!readOnly ? (
            <>
              <Divider sx={{ my: 5 }} />
              <Stack gap={4}>
                <TextField
                  label="Merchant"
                  value={merchant}
                  onChange={(event) => setMerchant(event.target.value)}
                  fullWidth
                />
                <TextField
                  select
                  label="Category"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  fullWidth
                  disabled={Boolean(splitCount)}
                  helperText={splitCount ? "Edit the split to change its categories." : undefined}
                >
                  <MenuItem value="Uncategorized">Uncategorized</MenuItem>
                  {categories
                    .filter(({ active }) => active)
                    .map((option) => (
                      <MenuItem key={option.id} value={option.name}>
                        {option.name}
                      </MenuItem>
                    ))}
                </TextField>
                <TextField
                  label="Envelope"
                  value={details?.splits.length ? "Defined per split" : item.envelope}
                  inputProps={{ readOnly: true }}
                  helperText="Use Split transaction to allocate this entry across envelopes."
                  fullWidth
                />
                <TextField
                  label="Notes"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  multiline
                  minRows={3}
                  fullWidth
                />
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    Tags
                  </Typography>
                  {tagDraft.length ? (
                    <Stack direction="row" gap={1.5} flexWrap="wrap" sx={{ mt: 2 }}>
                      {tagDraft.map((tag) => (
                        <Chip
                          key={tag.toLocaleLowerCase()}
                          label={tag}
                          onDelete={() =>
                            setTagDraft((current) => current.filter((value) => value !== tag))
                          }
                        />
                      ))}
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                      No tags yet.
                    </Typography>
                  )}
                  <Stack direction={{ xs: "column", sm: "row" }} gap={2} sx={{ mt: 2 }}>
                    <TextField
                      label="Add transaction tag"
                      value={newTag}
                      onChange={(event) => setNewTag(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        addTag();
                      }}
                      inputProps={{ maxLength: 40 }}
                      helperText="Press Enter or Add tag. Up to 20 tags."
                      fullWidth
                    />
                    <Button
                      variant="outlined"
                      startIcon={<LocalOfferRounded />}
                      onClick={addTag}
                      disabled={
                        !newTag.trim() ||
                        newTag.normalize("NFKC").trim().length > 40 ||
                        tagDraft.length >= 20
                      }
                      aria-label="Add tag to transaction"
                      sx={{ alignSelf: { sm: "flex-start" }, minHeight: 40 }}
                    >
                      Add tag
                    </Button>
                  </Stack>
                </Box>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={excluded}
                      onChange={(event) => setExcluded(event.target.checked)}
                    />
                  }
                  label={
                    <Box>
                      <Typography variant="body2" fontWeight={700}>
                        Exclude from reports
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Transaction remains in the ledger and audit history.
                      </Typography>
                    </Box>
                  }
                />
              </Stack>
              <Divider sx={{ my: 5 }} />
              <Typography variant="h3">Tools</Typography>
              <Box sx={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 2, mt: 3 }}>
                <Button
                  variant="outlined"
                  color="inherit"
                  startIcon={<CallSplitRounded />}
                  sx={{ justifyContent: "flex-start", minWidth: 0 }}
                  onClick={() => onAction("split")}
                >
                  {splitCount ? "Edit split" : "Split transaction"}
                </Button>
                <Tooltip
                  title={
                    transferMatched
                      ? "This transaction already has a confirmed transfer pair."
                      : transferSuggested
                        ? "Confirm or reject the suggested pair above before matching manually."
                        : "Match an exact opposite entry from another account."
                  }
                >
                  <span>
                    <Button
                      fullWidth
                      variant="outlined"
                      color="inherit"
                      startIcon={<SwapHorizRounded />}
                      sx={{ justifyContent: "flex-start", minWidth: 0 }}
                      disabled={transferMatched || transferSuggested}
                      onClick={() => onAction("transfer")}
                    >
                      {transferMatched
                        ? "Transfer matched"
                        : transferSuggested
                          ? "Review transfer suggestion"
                          : "Match transfer"}
                    </Button>
                  </span>
                </Tooltip>
                <Button
                  variant="outlined"
                  color="inherit"
                  startIcon={<LinkRounded />}
                  sx={{ justifyContent: "flex-start", minWidth: 0 }}
                  onClick={() => onAction("refund")}
                >
                  Link refund
                </Button>
                <Button
                  variant="outlined"
                  color="inherit"
                  startIcon={<RuleRounded />}
                  sx={{ justifyContent: "flex-start", minWidth: 0 }}
                  onClick={() => onAction("rule")}
                >
                  Create rule
                </Button>
              </Box>
              <Accordion
                disableGutters
                elevation={0}
                sx={{
                  mt: 5,
                  border: "1px solid",
                  borderColor: "divider",
                  "&::before": { display: "none" },
                }}
              >
                <AccordionSummary expandIcon={<ExpandMoreRounded />}>
                  <Stack direction="row" gap={2} alignItems="center">
                    <CloudDownloadRounded fontSize="small" />
                    <Typography variant="body2" fontWeight={700}>
                      Audit & provenance
                    </Typography>
                  </Stack>
                </AccordionSummary>
                <AccordionDetails>
                  <Stack gap={2}>
                    <Typography variant="body2">{item.provenance}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Raw source retained · User changes are audited · Linked facts stay traceable
                    </Typography>
                  </Stack>
                </AccordionDetails>
              </Accordion>
            </>
          ) : null}
        </Box>
        <Stack
          direction="row"
          justifyContent="space-between"
          gap={2}
          sx={{
            p: { xs: 3, sm: 4 },
            borderTop: "1px solid",
            borderColor: "divider",
            bgcolor: "background.paper",
            pb: { xs: "max(12px, env(safe-area-inset-bottom))", sm: 4 },
          }}
        >
          {item.status === "removed" ? (
            <Button
              variant="outlined"
              startIcon={<ReceiptLongRounded />}
              onClick={() => void changeStatus("restore")}
              disabled={Boolean(statusWorking)}
            >
              {statusWorking === "restore" ? "Restoring…" : "Restore transaction"}
            </Button>
          ) : item.status === "void" ? (
            <Box />
          ) : (
            <Button
              color="error"
              startIcon={<DeleteOutlineRounded />}
              onClick={() => setRemoveOpen(true)}
            >
              Remove transaction
            </Button>
          )}
          <Stack direction="row" gap={2}>
            <Button onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
            {!readOnly ? (
              <Button
                variant="contained"
                onClick={() => void save()}
                disabled={saving || !merchant.trim()}
                startIcon={<CheckCircleRounded />}
              >
                {saving
                  ? "Saving…"
                  : saved
                    ? "Saved"
                    : item.needsReview
                      ? "Save & approve"
                      : "Save changes"}
              </Button>
            ) : null}
          </Stack>
        </Stack>
        {saveError ? (
          <Alert severity="error" sx={{ m: 3, mt: 0 }}>
            {saveError}
          </Alert>
        ) : null}
        {statusError ? (
          <Alert severity="error" sx={{ m: 3, mt: 0 }}>
            {statusError}
          </Alert>
        ) : null}
        <Dialog
          open={removeOpen}
          onClose={() => (statusWorking ? undefined : setRemoveOpen(false))}
          fullWidth
          maxWidth="xs"
          aria-labelledby="remove-transaction-title"
        >
          <DialogTitle id="remove-transaction-title">Remove {item.merchant}?</DialogTitle>
          <DialogContent>
            <Alert severity="warning">
              This hides the entry from reports without deleting imported history. You can restore
              it from the Removed tab at any time.
            </Alert>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setRemoveOpen(false)} disabled={Boolean(statusWorking)}>
              Keep transaction
            </Button>
            <Button
              color="error"
              variant="contained"
              onClick={() => void changeStatus("remove")}
              disabled={Boolean(statusWorking)}
            >
              {statusWorking === "remove" ? "Removing…" : "Confirm removal"}
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </Drawer>
  );
}

export function TransactionsPage() {
  const demo = isDemoMode();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [demoTransactionData, setDemoTransactionData] = useState<ApiTransaction[]>(
    demoApiTransactions.data,
  );
  const [demoRemovedStatuses, setDemoRemovedStatuses] = useState<
    Record<string, "pending" | "posted" | "void">
  >({});
  const [query, setQuery] = useState("");
  const queryClient = useQueryClient();
  const result = useInfiniteQuery({
    queryKey: ["transactions", query],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "100" });
      if (query.trim()) params.set("query", query.trim());
      if (pageParam) params.set("cursor", pageParam);
      return api.transactions(params.toString());
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.page.hasMore ? (lastPage.page.cursor ?? undefined) : undefined,
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
  const updateTransaction = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<ApiTransaction> }) =>
      api.updateTransaction(id, patch),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["transactions"] }),
  });
  const bulkTransactions = useMutation({
    mutationFn: ({ ids, patch }: { ids: string[]; patch: Partial<ApiTransaction> }) =>
      api.bulkTransactions({ ids, patch }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["transactions"] }),
  });
  const replaceTags = useMutation({
    mutationFn: ({ id, tags }: { id: string; tags: string[] }) =>
      api.replaceTransactionTags(id, tags),
  });
  const removeEntry = useMutation({ mutationFn: api.removeTransaction });
  const restoreEntry = useMutation({ mutationFn: api.restoreTransaction });
  const transactionPage = demo
    ? { data: demoTransactionData, page: { cursor: null, hasMore: false } }
    : result.data
      ? {
          data: result.data.pages.flatMap(({ data }) => data),
          page: result.data.pages.at(-1)?.page ?? { cursor: null, hasMore: false },
        }
      : undefined;
  const allItems = transactionPage ? displayItems(transactionPage) : [];
  const categories = categoriesQuery.data?.data ?? [];
  const envelopes = envelopesQuery.data?.data ?? [];
  const accounts = accountsQuery.data?.data ?? [];
  const [tab, setTab] = useState("all");
  const [filters, setFilters] = useState<string[]>([]);
  const [rangeFilters, setRangeFilters] = useState<LedgerRangeFilters>({
    minimum: "",
    maximum: "",
    fromDate: "",
    toDate: "",
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<TransactionView | null>(null);
  const [action, setAction] = useState<TransactionAction | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCategory, setBulkCategory] = useState("");
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const [toast, setToast] = useState("");
  const detailId = detail?.id;
  const detailQuery = useQuery({
    queryKey: ["transaction", detailId],
    queryFn: () => {
      if (!detailId) throw new Error("Choose a transaction first.");
      return api.transaction(detailId);
    },
    enabled: !demo && Boolean(detailId),
    retry: 1,
  });
  const movementCandidatesQuery = useQuery({
    queryKey: [
      "movement-candidates",
      action,
      detail?.id,
      detail?.accountId,
      detail?.amountMinorUnits,
    ],
    queryFn: () => {
      if (!detail) throw new Error("Choose a transaction first.");
      if (action === "transfer") {
        const oppositeAmount = -BigInt(detail.amountMinorUnits);
        const query = new URLSearchParams({
          limit: "250",
          query: `${oppositeAmount < 0n ? "-" : ""}${minorUnitsToInput(oppositeAmount)}`,
        });
        return api.transactions(query.toString());
      }
      return api.accountTransactions(detail.accountId, 250);
    },
    enabled: !demo && Boolean(detail) && (action === "transfer" || action === "refund"),
    retry: 1,
  });
  const movementCandidateItems = useMemo(() => {
    if (demo || !movementCandidatesQuery.data) return allItems;
    const merged = new Map(allItems.map((item) => [item.id, item]));
    for (const item of displayItems(movementCandidatesQuery.data)) merged.set(item.id, item);
    return [...merged.values()];
  }, [allItems, demo, movementCandidatesQuery.data]);

  useEffect(() => {
    const requestedAction = searchParams.get("action");
    const requestedReview = searchParams.get("review") === "true";
    if (requestedAction !== "add" && requestedAction !== "import" && !requestedReview) return;
    if (requestedAction === "add") setManualOpen(true);
    if (requestedAction === "import") setImportOpen(true);
    if (requestedReview) setTab("review");
    const next = new URLSearchParams(searchParams);
    next.delete("action");
    next.delete("review");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const items = useMemo(
    () =>
      allItems.filter((item) =>
        matchesTransactionFilters(item, {
          query,
          tab,
          filters,
          range: rangeFilters,
        }),
      ),
    [allItems, filters, query, rangeFilters, tab],
  );

  const selectedTotal = allItems
    .filter((item) => selected.includes(item.id))
    .reduce((sum, item) => sum + item.amount, 0);
  const groups = [...new Set(items.map((item) => item.date))];
  const activeFilterCount =
    filters.length + Object.values(rangeFilters).filter((value) => Boolean(value)).length;
  const suggestedMatchCount = new Set(
    allItems.flatMap((item) =>
      item.status === "removed"
        ? []
        : [
            ...(item.transferMatch?.status === "suggested" ? [item.transferMatch.id] : []),
            ...item.refundLinkMatches
              .filter(({ status }) => status === "suggested")
              .map(({ id }) => id),
          ],
    ),
  ).size;
  const toggleAll = (checked: boolean) => setSelected(checked ? items.map((item) => item.id) : []);
  const saveTransaction = async (item: TransactionView, patch: Partial<ApiTransaction>) => {
    if (!demo) {
      await updateTransaction.mutateAsync({
        id: item.id,
        patch: item.needsReview ? { ...patch, reviewState: "approved" } : patch,
      });
    } else {
      setDemoTransactionData((current) =>
        current.map((transaction) =>
          transaction.id === item.id
            ? {
                ...transaction,
                merchant: patch.merchant ?? transaction.merchant,
                categoryName: patch.categoryName ?? transaction.categoryName,
                ...(patch.note !== undefined ? { note: patch.note } : {}),
                ...(patch.isExcluded !== undefined ? { isExcluded: patch.isExcluded } : {}),
                reviewState: item.needsReview ? "approved" : transaction.reviewState,
              }
            : transaction,
        ),
      );
    }
    setToast(`${item.merchant} saved${item.needsReview ? " and approved" : ""}`);
  };
  const applyBulk = async () => {
    if (!bulkCategory) return;
    const category = categories.find(({ id }) => id === bulkCategory);
    if (!category) return;
    if (!demo) {
      await bulkTransactions.mutateAsync({ ids: selected, patch: { categoryName: category.name } });
    } else {
      const selectedIds = new Set(selected);
      setDemoTransactionData((current) =>
        current.map((transaction) =>
          selectedIds.has(transaction.id)
            ? { ...transaction, categoryName: category.name }
            : transaction,
        ),
      );
    }
    setBulkOpen(false);
    setSelected([]);
    setToast(`Category changed to ${category.name} for ${selected.length} transactions`);
  };
  const invalidateLedgerAction = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["transactions"] }),
      queryClient.invalidateQueries({ queryKey: ["transaction", detailId] }),
      queryClient.invalidateQueries({ queryKey: ["budgets"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      queryClient.invalidateQueries({ queryKey: ["net-worth"] }),
    ]);
  };
  const saveTransactionTags = async (item: TransactionView, tags: string[]) => {
    const savedTags = demo ? tags : (await replaceTags.mutateAsync({ id: item.id, tags })).tags;
    if (demo) {
      setDemoTransactionData((current) =>
        current.map((transaction) =>
          transaction.id === item.id ? { ...transaction, tags: savedTags } : transaction,
        ),
      );
    }
    setDetail((current) => (current?.id === item.id ? { ...current, tags: savedTags } : current));
    await invalidateLedgerAction();
    setToast(`${savedTags.length} tag${savedTags.length === 1 ? "" : "s"} saved`);
  };
  const removeTransaction = async (item: TransactionView) => {
    if (demo) {
      if (item.status !== "removed") {
        setDemoRemovedStatuses((current) => ({
          ...current,
          [item.id]: item.status === "void" ? "void" : item.pending ? "pending" : "posted",
        }));
      }
      setDemoTransactionData((current) =>
        current.map((transaction) =>
          transaction.id === item.id ? { ...transaction, status: "removed" } : transaction,
        ),
      );
    } else {
      await removeEntry.mutateAsync(item.id);
    }
    setDetail((current) =>
      current?.id === item.id ? { ...current, status: "removed", pending: false } : current,
    );
    setSelected((current) => current.filter((id) => id !== item.id));
    setTab("removed");
    await invalidateLedgerAction();
    setToast(`${item.merchant} removed from reports · restore remains available`);
  };
  const restoreTransaction = async (item: TransactionView) => {
    const restoredStatus = demo
      ? (demoRemovedStatuses[item.id] ?? "posted")
      : (await restoreEntry.mutateAsync(item.id)).status;
    if (demo) {
      setDemoTransactionData((current) =>
        current.map((transaction) =>
          transaction.id === item.id ? { ...transaction, status: restoredStatus } : transaction,
        ),
      );
    }
    setDetail((current) =>
      current?.id === item.id
        ? { ...current, status: restoredStatus, pending: restoredStatus === "pending" }
        : current,
    );
    setTab("all");
    await invalidateLedgerAction();
    setToast(`${item.merchant} restored to the ledger`);
  };
  const saveSplits = async (splits: SplitDraft[]) => {
    if (!detail) return;
    if (!demo) await api.replaceTransactionSplits(detail.id, splits);
    setDetail((current) => (current ? { ...current, hasSplits: true } : current));
    await invalidateLedgerAction();
    setToast(`${detail.merchant} split saved exactly`);
  };
  const matchTransfer = async (input: {
    outflowTransactionId: string;
    inflowTransactionId: string;
  }) => {
    if (!demo) await api.matchTransfer(input);
    setDetail((current) =>
      current
        ? {
            ...current,
            isTransfer: true,
            excluded: true,
            transferId: current.transferId ?? "confirmed",
          }
        : current,
    );
    await invalidateLedgerAction();
    setToast("Transfer matched · both sides removed from spending");
  };
  const linkRefund = async (input: {
    refundTransactionId: string;
    purchaseTransactionId: string;
  }) => {
    if (!demo) await api.linkRefund(input);
    setDetail((current) =>
      current ? { ...current, refundLinkIds: [...current.refundLinkIds, "confirmed"] } : current,
    );
    await invalidateLedgerAction();
    setToast("Refund linked · net spending updated");
  };
  const confirmTransferSuggestion = (match: ApiTransferMatch) =>
    matchTransfer({
      outflowTransactionId: match.outflowTransactionId,
      inflowTransactionId: match.inflowTransactionId,
    });
  const rejectTransferSuggestion = async (id: string) => {
    if (!demo) await api.removeTransfer(id);
    setDetail((current) => {
      if (!current) return current;
      const { transferId: _transferId, transferMatch: _transferMatch, ...remaining } = current;
      return { ...remaining, isTransfer: false, excluded: false };
    });
    await invalidateLedgerAction();
    setToast("Transfer suggestion rejected · it will not be suggested again");
  };
  const confirmRefundSuggestion = (match: ApiRefundLinkMatch) =>
    linkRefund({
      refundTransactionId: match.refundTransactionId,
      purchaseTransactionId: match.purchaseTransactionId,
    });
  const rejectRefundSuggestion = async (id: string) => {
    if (!demo) await api.removeRefundLink(id);
    setDetail((current) =>
      current
        ? {
            ...current,
            refundLinkIds: current.refundLinkIds.filter((linkId) => linkId !== id),
            refundLinkMatches: current.refundLinkMatches.filter((match) => match.id !== id),
          }
        : current,
    );
    await invalidateLedgerAction();
    setToast("Refund suggestion rejected · it will not be suggested again");
  };
  const previewRule = (input: Pick<ApiRule, "conditions" | "actions">): Promise<RulePreview> => {
    if (!demo) return api.previewRule(input);
    return Promise.resolve({
      matchCount: 1,
      aggregateAmount: detail
        ? { minorUnits: detail.amountMinorUnits, currency: detail.currency }
        : { minorUnits: "0", currency: "USD" },
      samples: [],
      conflicts: [],
    });
  };
  const createRule = async (input: RuleCreateInput) => {
    if (!demo) await api.createRule(input);
    await queryClient.invalidateQueries({ queryKey: ["rules"] });
    setToast(`Rule “${input.name}” created after preview`);
  };
  const createManualTransaction = async (input: Parameters<typeof api.createTransaction>[0]) => {
    if (!demo) {
      await api.createTransaction(input);
    } else {
      const account = accounts.find(({ id }) => id === input.accountId);
      const category = categories.find(({ id }) => id === input.categoryId);
      setDemoTransactionData((current) => [
        {
          id: `demo-transaction-${Date.now()}`,
          accountId: input.accountId,
          effectiveDate: input.effectiveDate,
          description: input.description,
          merchant: input.description,
          amount: { minorUnits: input.amountMinorUnits, currency: input.currency },
          accountName: account?.name ?? "Manual account",
          categoryName: category?.name ?? "Uncategorized",
          status: "posted",
          reviewState: category ? "approved" : "needs_review",
          source: "manual",
          note: input.note ?? "",
          tags: [],
          isTransfer: false,
          isExcluded: false,
          isIncome: BigInt(input.amountMinorUnits) > 0n,
          hasSplits: false,
          refundLinkIds: [],
          refundLinks: [],
        },
        ...current,
      ]);
    }
    await invalidateLedgerAction();
    setToast("Manual transaction added to the reviewable ledger");
  };
  const importTransactions = async (
    input: Parameters<typeof api.importTransactions>[0],
  ): Promise<ApiTransactionImportResult> => {
    const imported = demo
      ? {
          id: "demo-import",
          state: "succeeded" as const,
          totalRecords: estimatedImportRecords(input.filename, input.content),
          importedRecords: estimatedImportRecords(input.filename, input.content),
          duplicateRecords: 0,
          rejectedRecords: 0,
        }
      : await api.importTransactions(input);
    await invalidateLedgerAction();
    setToast(`${imported.importedRecords} transactions imported`);
    return imported;
  };
  const closeDetail = () => {
    if (action) return;
    setDetail(null);
  };

  if (!demo && result.isPending) {
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Ledger"
          title="Loading transactions"
          description="Fetching the latest reconciled ledger."
        />
        <LoadingCard rows={8} />
      </Stack>
    );
  }
  if (!demo && result.isError) {
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Ledger"
          title="Transactions unavailable"
          description="No ledger changes have been made."
        />
        <ErrorState
          message="BetterWealth could not load the transaction ledger."
          onRetry={() => result.refetch()}
        />
      </Stack>
    );
  }

  return (
    <Stack gap={5}>
      <PageHeader
        eyebrow="Ledger"
        title="Transactions"
        description="Every imported fact stays traceable. Review uncertain edge cases; let narrow, previewed rules handle the rest."
        actions={
          <>
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<CloudDownloadRounded />}
              onClick={() => setImportOpen(true)}
            >
              Import
            </Button>
            <Button variant="contained" onClick={() => setManualOpen(true)}>
              Add transaction
            </Button>
          </>
        }
      />
      {suggestedMatchCount ? (
        <Alert
          severity="warning"
          action={
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                setTab("review");
                setFilters((current) =>
                  current.includes("Suggested match") ? current : [...current, "Suggested match"],
                );
              }}
            >
              Review matches
            </Button>
          }
        >
          <strong>
            {suggestedMatchCount} transfer or refund{" "}
            {suggestedMatchCount === 1 ? "match" : "matches"}
          </strong>{" "}
          need confirmation. Suggestions do not change spending, income, or budgets until you
          approve them.
        </Alert>
      ) : null}
      <Paper variant="outlined" sx={{ overflow: "hidden", borderRadius: 3.5 }}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          alignItems={{ xs: "stretch", md: "center" }}
          justifyContent="space-between"
          gap={3}
          sx={{ p: 3 }}
        >
          <Tabs
            value={tab}
            onChange={(_, value: string) => setTab(value)}
            aria-label="Transaction views"
            sx={{ minHeight: 44 }}
          >
            <Tab
              value="all"
              label={`Loaded ${allItems.filter(({ status }) => status !== "removed").length}`}
            />
            <Tab
              value="review"
              label={`Loaded review ${allItems.filter((item) => item.status !== "removed" && (item.needsReview || hasSuggestedMatch(item))).length}`}
            />
            <Tab
              value="removed"
              label={`Loaded removed ${allItems.filter(({ status }) => status === "removed").length}`}
            />
          </Tabs>
          <Stack direction="row" gap={2}>
            <TextField
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search ledger"
              inputProps={{ "aria-label": "Search transactions" }}
              sx={{ flex: 1, minWidth: 0 }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchRounded />
                  </InputAdornment>
                ),
              }}
            />
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<FilterListRounded />}
              onClick={() => setFiltersOpen(true)}
              aria-label={`Filters${activeFilterCount ? `, ${activeFilterCount} active` : ""}`}
            >
              <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>
                Filters
              </Box>
              {activeFilterCount ? (
                <Chip label={activeFilterCount} size="small" color="primary" sx={{ ml: 1 }} />
              ) : null}
            </Button>
            <Tooltip title="More ledger actions">
              <IconButton
                aria-label="More ledger actions"
                onClick={(event) => setMoreAnchor(event.currentTarget)}
              >
                <MoreHorizRounded />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
        {selected.length ? (
          <Stack
            direction={{ xs: "column", sm: "row" }}
            alignItems={{ xs: "stretch", sm: "center" }}
            justifyContent="space-between"
            gap={2}
            sx={{
              px: 4,
              py: 2,
              bgcolor: (theme) => alpha(theme.palette.primary.main, 0.08),
              borderTop: "1px solid",
              borderColor: "divider",
            }}
          >
            <Typography variant="body2">
              <strong>{selected.length} selected</strong> · aggregate{" "}
              <Money value={selectedTotal} sign />
            </Typography>
            <Stack direction="row" gap={2}>
              <Button size="small" onClick={() => setSelected([])}>
                Clear
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={() => {
                  setBulkCategory(
                    categories.find(({ name }) => name === "Groceries")?.id ??
                      categories[0]?.id ??
                      "",
                  );
                  setBulkOpen(true);
                }}
              >
                Review bulk change
              </Button>
            </Stack>
          </Stack>
        ) : null}
        <Box sx={{ display: { xs: "none", sm: "block" }, overflowX: "auto" }}>
          <Box sx={{ minWidth: 880 }}>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns:
                  "44px minmax(210px, 1.7fr) minmax(135px, .85fr) minmax(130px, .8fr) minmax(120px, .72fr)",
                gap: 2,
                alignItems: "center",
                minHeight: 44,
                px: 3,
                bgcolor: "action.hover",
                borderTop: "1px solid",
                borderBottom: "1px solid",
                borderColor: "divider",
              }}
            >
              {tab === "removed" ? (
                <RemoveCircleOutlineRounded color="disabled" aria-label="Removed transactions" />
              ) : (
                <Checkbox
                  size="small"
                  checked={items.length > 0 && selected.length === items.length}
                  indeterminate={selected.length > 0 && selected.length < items.length}
                  onChange={(event) => toggleAll(event.target.checked)}
                  inputProps={{ "aria-label": "Select all visible transactions" }}
                />
              )}
              {["Merchant", "Category / envelope", "Account", "Amount"].map((header, index) => (
                <Typography
                  key={header}
                  variant="caption"
                  color="text.secondary"
                  fontWeight={750}
                  textAlign={index === 3 ? "right" : "left"}
                >
                  {header}
                </Typography>
              ))}
            </Box>
            {groups.map((group) => (
              <Box key={group}>
                <Typography
                  variant="overline"
                  color="text.secondary"
                  sx={{ display: "block", px: 4, py: 2, bgcolor: "background.default" }}
                >
                  {group}
                </Typography>
                {items
                  .filter((item) => item.date === group)
                  .map((item) => (
                    <TransactionRow
                      key={item.id}
                      item={item}
                      checked={selected.includes(item.id)}
                      onCheck={(checked) =>
                        setSelected(
                          checked
                            ? [...selected, item.id]
                            : selected.filter((id) => id !== item.id),
                        )
                      }
                      onOpen={() => setDetail(item)}
                    />
                  ))}
              </Box>
            ))}
          </Box>
        </Box>
        <Stack
          gap={2}
          sx={{
            display: { xs: "flex", sm: "none" },
            p: 3,
            borderTop: "1px solid",
            borderColor: "divider",
          }}
        >
          {groups.map((group) => (
            <Box key={group}>
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ display: "block", py: 2 }}
              >
                {group}
              </Typography>
              <Stack gap={2}>
                {items
                  .filter((item) => item.date === group)
                  .map((item) => (
                    <MobileTransactionRow
                      key={item.id}
                      item={item}
                      checked={selected.includes(item.id)}
                      onCheck={(checked) =>
                        setSelected(
                          checked
                            ? [...selected, item.id]
                            : selected.filter((id) => id !== item.id),
                        )
                      }
                      onOpen={() => setDetail(item)}
                    />
                  ))}
              </Stack>
            </Box>
          ))}
        </Stack>
        {!demo && result.hasNextPage ? (
          <Stack
            direction={{ xs: "column", sm: "row" }}
            justifyContent="space-between"
            alignItems={{ xs: "stretch", sm: "center" }}
            gap={2}
            sx={{ px: 4, py: 3, borderTop: "1px solid", borderColor: "divider" }}
          >
            <Typography variant="caption" color="text.secondary">
              {allItems.length} transactions loaded. Older ledger history remains available.
            </Typography>
            <Button
              variant="outlined"
              onClick={() => void result.fetchNextPage()}
              disabled={result.isFetchingNextPage}
            >
              {result.isFetchingNextPage ? "Loading older…" : "Load older transactions"}
            </Button>
          </Stack>
        ) : null}
        {!items.length ? (
          <Stack alignItems="center" textAlign="center" sx={{ py: 12, px: 4 }}>
            <SearchRounded sx={{ fontSize: 36, color: "text.disabled" }} />
            <Typography variant="h3" sx={{ mt: 3 }}>
              No matching transactions
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Clear a filter or try a merchant, amount, account, or note.
            </Typography>
            <Button
              onClick={() => {
                setQuery("");
                setFilters([]);
                setRangeFilters({ minimum: "", maximum: "", fromDate: "", toDate: "" });
              }}
              sx={{ mt: 3 }}
            >
              Clear search and filters
            </Button>
          </Stack>
        ) : null}
      </Paper>

      <Drawer
        anchor="right"
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        PaperProps={{ sx: { width: { xs: "100%", sm: 390 }, maxWidth: "100%" } }}
      >
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
          sx={{ px: 5, py: 4, borderBottom: "1px solid", borderColor: "divider" }}
        >
          <Box>
            <Typography variant="h3">Filter ledger</Typography>
            <Typography variant="caption" color="text.secondary">
              Combine filters to narrow the truth.
            </Typography>
          </Box>
          <IconButton onClick={() => setFiltersOpen(false)} aria-label="Close filters">
            <CloseRounded />
          </IconButton>
        </Stack>
        <Box sx={{ p: 5, overflowY: "auto", flex: 1 }}>
          <FilterContent
            selected={filters}
            setSelected={setFilters}
            range={rangeFilters}
            setRange={setRangeFilters}
          />
        </Box>
        <Stack
          direction="row"
          justifyContent="space-between"
          sx={{ p: 4, borderTop: "1px solid", borderColor: "divider" }}
        >
          <Button
            onClick={() => {
              setFilters([]);
              setRangeFilters({ minimum: "", maximum: "", fromDate: "", toDate: "" });
            }}
          >
            Reset
          </Button>
          <Button variant="contained" onClick={() => setFiltersOpen(false)}>
            Show {items.length} results
          </Button>
        </Stack>
      </Drawer>

      <ManualTransactionDialog
        open={manualOpen}
        accounts={accounts}
        categories={categories}
        onClose={() => setManualOpen(false)}
        onSubmit={createManualTransaction}
      />
      <ImportTransactionsDialog
        open={importOpen}
        accounts={accounts}
        onClose={() => setImportOpen(false)}
        onSubmit={importTransactions}
      />
      <TransactionDetail
        item={detail}
        details={detailQuery.data}
        transactions={allItems}
        detailLoading={detailQuery.isPending && !demo && Boolean(detail)}
        detailError={detailQuery.error instanceof Error ? detailQuery.error.message : null}
        categories={categories}
        open={Boolean(detail)}
        onClose={closeDetail}
        onSave={saveTransaction}
        onSaveTags={saveTransactionTags}
        onRemove={removeTransaction}
        onRestore={restoreTransaction}
        onAction={setAction}
        onConfirmTransferSuggestion={confirmTransferSuggestion}
        onRejectTransferSuggestion={rejectTransferSuggestion}
        onConfirmRefundSuggestion={confirmRefundSuggestion}
        onRejectRefundSuggestion={rejectRefundSuggestion}
        saving={updateTransaction.isPending || replaceTags.isPending}
        saveError={
          updateTransaction.error instanceof Error
            ? updateTransaction.error.message
            : replaceTags.error instanceof Error
              ? replaceTags.error.message
              : null
        }
      />
      <SplitTransactionDialog
        open={action === "split"}
        item={detail}
        detail={detailQuery.data}
        categories={categories}
        envelopes={envelopes}
        onClose={() => setAction(null)}
        onSubmit={saveSplits}
      />
      <MatchTransferDialog
        open={action === "transfer"}
        item={detail}
        transactions={movementCandidateItems}
        onClose={() => setAction(null)}
        onSubmit={matchTransfer}
      />
      <LinkRefundDialog
        open={action === "refund"}
        item={detail}
        transactions={movementCandidateItems}
        onClose={() => setAction(null)}
        onSubmit={linkRefund}
      />
      <CreateTransactionRuleDialog
        open={action === "rule"}
        item={detail}
        detail={detailQuery.data}
        categories={categories}
        onClose={() => setAction(null)}
        onPreview={previewRule}
        onSubmit={createRule}
      />
      <Dialog open={bulkOpen} onClose={() => setBulkOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Preview bulk change</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">
            You’re about to edit {selected.length} transactions totaling{" "}
            <Money value={selectedTotal} sign />. The API applies this as one transactional,
            auditable batch.
          </Typography>
          <TextField
            select
            fullWidth
            label="Set category"
            value={bulkCategory}
            onChange={(event) => setBulkCategory(event.target.value)}
            sx={{ mt: 5 }}
          >
            {categories
              .filter(({ active }) => active)
              .map((category) => (
                <MenuItem key={category.id} value={category.id}>
                  {category.name}
                </MenuItem>
              ))}
          </TextField>
        </DialogContent>
        {bulkTransactions.error instanceof Error ? (
          <Alert severity="error" sx={{ mx: 3 }}>
            {bulkTransactions.error.message}
          </Alert>
        ) : null}
        <DialogActions>
          <Button onClick={() => setBulkOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={bulkTransactions.isPending || !bulkCategory}
            onClick={() => void applyBulk()}
          >
            {bulkTransactions.isPending ? "Applying…" : `Apply to ${selected.length}`}
          </Button>
        </DialogActions>
      </Dialog>
      <Menu anchorEl={moreAnchor} open={Boolean(moreAnchor)} onClose={() => setMoreAnchor(null)}>
        <MenuItem
          onClick={() => {
            setMoreAnchor(null);
            navigate("/automation");
          }}
        >
          <ListItemIcon>
            <AutoAwesomeRounded fontSize="small" />
          </ListItemIcon>
          Manage rules & AI review
        </MenuItem>
      </Menu>
      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={5000}
        onClose={() => setToast("")}
        message={toast}
        action={
          <Button color="secondary" onClick={() => setToast("")}>
            Dismiss
          </Button>
        }
      />
    </Stack>
  );
}
