import {
  AccountBalanceWalletRounded,
  AddRounded,
  ArchiveRounded,
  ArrowForwardRounded,
  AutoAwesomeRounded,
  CalendarMonthRounded,
  CheckCircleRounded,
  EditRounded,
  PaymentsRounded,
  RemoveCircleOutlineRounded,
  SwapHorizRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import {
  Alert,
  alpha,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Slider,
  Tab,
  Tabs,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  type ApiBudget,
  type ApiEnvelope,
  api,
  type CursorPage,
  type Money as TransportMoney,
} from "../api";
import { Stack, TextField, Typography } from "../components/mui";
import {
  EmptyState,
  ErrorState,
  LoadingCard,
  MetricCard,
  Money,
  PageHeader,
  ProgressMeter,
  SectionHeader,
  StatusChip,
} from "../components/ui";
import { envelopes as demoEnvelopeData } from "../data";
import { isDemoMode } from "../demo";

function transportMoneyFromMinor(minorUnits: bigint, currency = "USD"): TransportMoney {
  return { minorUnits: minorUnits.toString(), currency };
}

function transportMoney(value: number) {
  return transportMoneyFromMinor(BigInt(Math.round(value * 100)));
}

function minor(value: TransportMoney | undefined) {
  return BigInt(value?.minorUnits ?? "0");
}

function dollars(value: TransportMoney | undefined) {
  return Number(minor(value)) / 100;
}

function parseDollars(value: string): bigint | null {
  const normalized = value.trim().replaceAll(",", "");
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(normalized);
  if (!match) return null;
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
}

function dateLabel(
  value: string,
  options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" },
) {
  return new Intl.DateTimeFormat(undefined, options).format(
    new Date(`${value.slice(0, 10)}T12:00:00`),
  );
}

function percent(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) return 0;
  return Math.min(999, Number((numerator * 100n) / denominator));
}

const demoBudget: ApiBudget = {
  id: "budget_demo",
  periodKind: "pay_cycle",
  startDate: "2026-07-16",
  endDate: "2026-07-30",
  plannedIncome: transportMoney(2_200),
  funded: transportMoney(2_050),
  spent: transportMoney(121.73),
  remaining: transportMoney(1_928.27),
  unassigned: transportMoney(150),
  totalPlanned: transportMoney(2_050),
  surplus: transportMoney(150),
  status: "open",
  envelopes: demoEnvelopeData.map((envelope, index) => ({
    id: `env_demo_${index}`,
    name: envelope.name,
    planned: transportMoney(envelope.planned),
    funded: transportMoney(envelope.funded),
    activity: transportMoney(-Math.abs(envelope.activity)),
    available: transportMoney(envelope.available),
    cadence: envelope.cadence,
    pacing: envelope.pacing === "on-track" ? "on_track" : envelope.pacing,
    rolloverPolicy: "none",
    transferredIn: transportMoney(0),
    transferredOut: transportMoney(0),
    parentId: null,
    categoryId: null,
    categoryIds: [],
    priority: 100 - index * 10,
    minimumAmount: transportMoney(envelope.planned),
    targetAmount: transportMoney(envelope.planned),
    isRequired: index < 3,
    isActive: true,
  })),
};

const demoBudgets: CursorPage<ApiBudget> = {
  data: [demoBudget],
  page: { cursor: null, hasMore: false },
};

const planColors = ["#1F3A5F", "#4A7FD1", "#1F9D72", "#5BA98B", "#8B6CCF", "#D98B2B", "#DD625B"];

type EnvelopeEditor = {
  id?: string;
  name: string;
  amount: string;
  categoryId: string;
  priority: string;
  isRequired: boolean;
  rolloverPolicy: "none" | "positive" | "all";
  matchText: string;
};

const emptyEditor: EnvelopeEditor = {
  name: "",
  amount: "",
  categoryId: "",
  priority: "100",
  isRequired: false,
  rolloverPolicy: "positive",
  matchText: "",
};

type MonthlyRow = {
  key: number;
  name: string;
  amount: string;
  categoryId: string;
  priority: string;
  isRequired: boolean;
};

function EnvelopeCard({
  envelope,
  onCover,
  onEdit,
}: {
  envelope: ApiEnvelope;
  onCover: () => void;
  onEdit: () => void;
}) {
  const activity = minor(envelope.activity);
  const spent = activity < 0n ? -activity : 0n;
  const funded = minor(envelope.funded);
  const available = minor(envelope.available);
  const used = percent(spent, funded || minor(envelope.planned));
  const tone =
    envelope.pacing === "over" ? "#DD625B" : envelope.pacing === "watch" ? "#D98B2B" : "#1F9D72";
  const status =
    envelope.pacing === "over"
      ? "Over plan"
      : envelope.pacing === "watch"
        ? "Watch pace"
        : "On pace";
  return (
    <Card
      sx={{
        position: "relative",
        overflow: "visible",
        borderColor: envelope.pacing === "over" ? alpha("#DD625B", 0.42) : "divider",
      }}
    >
      {envelope.pacing === "over" ? (
        <Box
          sx={{
            position: "absolute",
            top: -1,
            left: 18,
            right: 18,
            height: 3,
            borderRadius: "0 0 4px 4px",
            bgcolor: "error.main",
          }}
        />
      ) : null}
      <CardContent sx={{ p: 4.5 }}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={2}>
          <Stack direction="row" gap={2.5} alignItems="center">
            <Box
              sx={{
                width: 40,
                height: 40,
                borderRadius: 2.5,
                display: "grid",
                placeItems: "center",
                color: tone,
                bgcolor: alpha(tone, 0.11),
              }}
            >
              {envelope.pacing === "over" ? (
                <WarningAmberRounded fontSize="small" />
              ) : envelope.isRequired ? (
                <CalendarMonthRounded fontSize="small" />
              ) : (
                <PaymentsRounded fontSize="small" />
              )}
            </Box>
            <Box>
              <Typography variant="h3">{envelope.name}</Typography>
              <Typography variant="caption" color="text.secondary">
                {envelope.isRequired ? "Required" : envelope.cadence} · priority{" "}
                {envelope.priority ?? 100}
              </Typography>
            </Box>
          </Stack>
          <IconButton size="small" aria-label={`Edit ${envelope.name}`} onClick={onEdit}>
            <EditRounded fontSize="small" />
          </IconButton>
        </Stack>
        <Box sx={{ mt: 5 }}>
          <Stack direction="row" alignItems="flex-end" justifyContent="space-between">
            <Box>
              <Typography variant="caption" color="text.secondary">
                Available
              </Typography>
              <Typography
                sx={{
                  mt: 0.5,
                  fontSize: 25,
                  fontWeight: 750,
                  color: available < 0n ? "error.main" : "text.primary",
                }}
              >
                <Money value={Number(available) / 100} />
              </Typography>
            </Box>
            <StatusChip
              label={status}
              tone={
                envelope.pacing === "over"
                  ? "risk"
                  : envelope.pacing === "watch"
                    ? "warning"
                    : "positive"
              }
            />
          </Stack>
        </Box>
        <Box sx={{ mt: 4 }}>
          <ProgressMeter
            value={used}
            color={tone}
            label={`${envelope.name}: ${used} percent used`}
          />
          <Stack direction="row" justifyContent="space-between" sx={{ mt: 2 }}>
            <Typography variant="caption" color="text.secondary">
              <Money value={Number(spent) / 100} /> spent
            </Typography>
            <Typography variant="caption" color="text.secondary">
              <Money value={Number(funded) / 100} /> funded
            </Typography>
          </Stack>
        </Box>
        {envelope.pacing === "over" ? (
          <Button
            fullWidth
            variant="outlined"
            color="error"
            startIcon={<SwapHorizRounded />}
            onClick={onCover}
            sx={{ mt: 4 }}
          >
            Cover <Money value={Number(-available) / 100} />
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FundingPlan({ budget, onEdit }: { budget: ApiBudget; onEdit: () => void }) {
  const items = budget.envelopes.filter((envelope) => envelope.isActive !== false);
  const total = items.reduce((sum, envelope) => sum + minor(envelope.planned), 0n);
  return (
    <Card>
      <CardContent sx={{ p: { xs: 4, sm: 5 } }}>
        <SectionHeader
          title="Paycheck funding plan"
          description="Required envelopes fund first, then the remaining envelopes follow their saved priority."
          action={
            <Button startIcon={<EditRounded />} onClick={onEdit}>
              Edit plan
            </Button>
          }
        />
        {total > 0n ? (
          <Box
            sx={{ display: "flex", height: 14, borderRadius: 99, overflow: "hidden", mt: 5 }}
            role="img"
            aria-label="Paycheck allocation composition"
          >
            {items.map((item, index) => (
              <Box
                key={item.id}
                sx={{
                  width: `${Number((minor(item.planned) * 10_000n) / total) / 100}%`,
                  bgcolor: planColors[index % planColors.length],
                }}
              />
            ))}
          </Box>
        ) : null}
        <Stack gap={0} sx={{ mt: 4 }}>
          {items.map((item, index) => (
            <Stack
              key={item.id}
              direction="row"
              alignItems="center"
              gap={2.5}
              sx={{
                minHeight: 58,
                borderBottom: index === items.length - 1 ? 0 : "1px solid",
                borderColor: "divider",
              }}
            >
              <Typography variant="caption" color="text.disabled" sx={{ width: 20 }}>
                {index + 1}
              </Typography>
              <Box
                sx={{
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  bgcolor: planColors[index % planColors.length],
                }}
              />
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="body2" fontWeight={700}>
                  {item.name}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {item.isRequired ? "Required" : "Flexible"} · priority {item.priority ?? 100}
                </Typography>
              </Box>
              <Typography variant="body2" fontWeight={750}>
                <Money value={dollars(item.planned)} />
              </Typography>
            </Stack>
          ))}
        </Stack>
        <Divider sx={{ my: 4 }} />
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={1}>
          <Typography variant="body2" fontWeight={700}>
            Plan total
          </Typography>
          <Typography variant="body2" fontWeight={750}>
            <Money value={Number(total) / 100} /> of <Money value={dollars(budget.plannedIncome)} />{" "}
            expected
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}

export function BudgetPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<"paycheck" | "month" | "plan">("paycheck");
  const [coverOpen, setCoverOpen] = useState(false);
  const [coverEnvelopeId, setCoverEnvelopeId] = useState("");
  const [sourceEnvelopeId, setSourceEnvelopeId] = useState("unassigned");
  const [coverAmount, setCoverAmount] = useState("");
  const [fundOpen, setFundOpen] = useState(false);
  const [fundPercent, setFundPercent] = useState(100);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editor, setEditor] = useState<EnvelopeEditor>(emptyEditor);
  const [buildOpen, setBuildOpen] = useState(false);
  const [paychecksPerYear, setPaychecksPerYear] = useState<12 | 24 | 26 | 52>(26);
  const [monthlyIncome, setMonthlyIncome] = useState("");
  const [monthlyRows, setMonthlyRows] = useState<MonthlyRow[]>([
    { key: 1, name: "Housing", amount: "", categoryId: "", priority: "500", isRequired: true },
    { key: 2, name: "Groceries", amount: "", categoryId: "", priority: "300", isRequired: true },
    { key: 3, name: "Fun money", amount: "", categoryId: "", priority: "50", isRequired: false },
  ]);
  const demo = isDemoMode();
  const queryClient = useQueryClient();
  const apiView = view === "month" ? "month" : view === "plan" ? "plan" : "pay_cycle";
  const budgetQuery = useQuery({
    queryKey: ["budgets", apiView],
    queryFn: () => api.budgets(apiView),
    initialData: demo ? demoBudgets : undefined,
    enabled: !demo,
    retry: 1,
  });
  const categoriesQuery = useQuery({
    queryKey: ["categories"],
    queryFn: api.categories,
    enabled: !demo,
    retry: 1,
  });
  const budget = budgetQuery.data?.data[0];
  const categories =
    categoriesQuery.data?.data.filter(
      (category) => category.active && category.kind !== "income" && category.kind !== "transfer",
    ) ?? [];
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["budgets"] }),
      queryClient.invalidateQueries({ queryKey: ["envelopes"] }),
      queryClient.invalidateQueries({ queryKey: ["rules"] }),
    ]);
  };

  useEffect(() => {
    if (searchParams.get("action") !== "add-envelope") return;
    setEditor(emptyEditor);
    setEditorOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("action");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const overages = useMemo(
    () =>
      budget?.envelopes.filter(
        (envelope) => envelope.isActive !== false && minor(envelope.available) < 0n,
      ) ?? [],
    [budget],
  );
  const selectedOverage =
    budget?.envelopes.find((envelope) => envelope.id === coverEnvelopeId) ?? overages[0];
  const sourceOptions = useMemo(() => {
    if (!budget || !selectedOverage) return [];
    return budget.envelopes.filter(
      (envelope) =>
        envelope.id !== selectedOverage.id &&
        envelope.isActive !== false &&
        minor(envelope.available) > 0n,
    );
  }, [budget, selectedOverage]);
  const openCover = (envelope: ApiEnvelope) => {
    setCoverEnvelopeId(envelope.id);
    const needed = -minor(envelope.available);
    setCoverAmount(`${needed / 100n}.${(needed % 100n).toString().padStart(2, "0")}`);
    const firstFundedSource = budget?.envelopes.find(
      (candidate) =>
        candidate.id !== envelope.id &&
        candidate.isActive !== false &&
        minor(candidate.available) > 0n,
    );
    setSourceEnvelopeId(
      minor(budget?.unassigned) > 0n ? "unassigned" : (firstFundedSource?.id ?? "unassigned"),
    );
    setCoverOpen(true);
  };
  const coverMinor = parseDollars(coverAmount);
  const sourceAvailable =
    sourceEnvelopeId === "unassigned"
      ? minor(budget?.unassigned)
      : minor(budget?.envelopes.find((envelope) => envelope.id === sourceEnvelopeId)?.available);
  const coverValid = Boolean(
    selectedOverage && coverMinor && coverMinor > 0n && coverMinor <= sourceAvailable,
  );

  const allocation = useMutation({
    mutationFn: () => {
      if (!budget || !selectedOverage || !coverMinor) throw new Error("Choose a valid transfer.");
      return api.createAllocation({
        budgetId: budget.id,
        fromEnvelopeId: sourceEnvelopeId === "unassigned" ? null : sourceEnvelopeId,
        toEnvelopeId: selectedOverage.id,
        amount: transportMoneyFromMinor(coverMinor, budget.plannedIncome.currency),
        reason: `Cover ${selectedOverage.name} overspending`,
      });
    },
    onSuccess: async () => {
      setCoverOpen(false);
      await invalidate();
    },
  });

  const fundingAmount = budget ? (minor(budget.plannedIncome) * BigInt(fundPercent)) / 100n : 0n;
  const fundingPreview = useMemo(() => {
    if (!budget) return [];
    let available = fundingAmount;
    return budget.envelopes
      .filter((envelope) => envelope.isActive !== false)
      .map((envelope) => {
        const planned = minor(envelope.planned);
        const assigned = available > planned ? planned : available;
        available -= assigned;
        return { envelope, assigned };
      });
  }, [budget, fundingAmount]);
  const previewAssigned = fundingPreview.reduce((sum, item) => sum + item.assigned, 0n);
  const fundBudget = useMutation({
    mutationFn: () => {
      if (!budget) throw new Error("No budget period is available.");
      return api.updateBudget(budget.id, {
        funded: transportMoneyFromMinor(fundingAmount, budget.plannedIncome.currency),
      });
    },
    onSuccess: async () => {
      setFundOpen(false);
      await invalidate();
    },
  });

  const saveEnvelope = useMutation({
    mutationFn: async () => {
      const amount = parseDollars(editor.amount);
      const priority = Number(editor.priority);
      if (amount === null || !Number.isInteger(priority))
        throw new Error("Enter a valid amount and whole-number priority.");
      const saved = editor.id
        ? await api.updateEnvelope(editor.id, {
            name: editor.name.trim(),
            planned: transportMoneyFromMinor(amount, budget?.plannedIncome.currency ?? "USD"),
            categoryId: editor.categoryId || null,
            categoryIds: editor.categoryId ? [editor.categoryId] : [],
            priority,
            isRequired: editor.isRequired,
            rolloverPolicy: editor.rolloverPolicy,
            isActive: true,
          })
        : await api.createEnvelope({
            name: editor.name.trim(),
            planned: transportMoneyFromMinor(amount, budget?.plannedIncome.currency ?? "USD"),
            cadence: budget?.periodKind === "month" ? "monthly" : "paycheck",
            categoryId: editor.categoryId || null,
            categoryIds: editor.categoryId ? [editor.categoryId] : [],
            priority,
            isRequired: editor.isRequired,
            rolloverPolicy: editor.rolloverPolicy,
          });
      if (editor.matchText.trim()) {
        await api.createRule({
          name: `${editor.matchText.trim()} → ${saved.name}`,
          priority,
          enabled: true,
          origin: "user",
          conditions: {
            field: "description",
            operator: "contains",
            value: editor.matchText.trim(),
            caseSensitive: false,
          },
          actions: [
            ...(editor.categoryId ? [{ type: "setCategory", categoryId: editor.categoryId }] : []),
            { type: "setEnvelope", envelopeId: saved.id },
          ],
        });
      }
      return saved;
    },
    onSuccess: async () => {
      setEditorOpen(false);
      setEditor(emptyEditor);
      await invalidate();
    },
  });
  const archiveEnvelope = useMutation({
    mutationFn: (id: string) => api.archiveEnvelope(id),
    onSuccess: async () => {
      setEditorOpen(false);
      setEditor(emptyEditor);
      await invalidate();
    },
  });
  const editEnvelope = (envelope: ApiEnvelope) => {
    setEditor({
      id: envelope.id,
      name: envelope.name,
      amount: (Number(minor(envelope.planned)) / 100).toFixed(2),
      categoryId: envelope.categoryId ?? envelope.categoryIds?.[0] ?? "",
      priority: String(envelope.priority ?? 100),
      isRequired: envelope.isRequired ?? false,
      rolloverPolicy:
        envelope.rolloverPolicy === "none" || envelope.rolloverPolicy === "all"
          ? envelope.rolloverPolicy
          : "positive",
      matchText: "",
    });
    setEditorOpen(true);
  };

  const validMonthlyRows = monthlyRows.filter(
    (row) => row.name.trim() && parseDollars(row.amount) !== null,
  );
  const buildPlan = useMutation({
    mutationFn: () => {
      if (!budget) throw new Error("Create a budget period first.");
      const income = monthlyIncome.trim() ? parseDollars(monthlyIncome) : null;
      if (monthlyIncome.trim() && income === null)
        throw new Error("Enter monthly income in dollars and cents.");
      if (!validMonthlyRows.length) throw new Error("Add at least one monthly spending estimate.");
      return api.buildBudgetFromMonthlySpend(budget.id, {
        paychecksPerYear,
        ...(income === null
          ? {}
          : { monthlyIncome: transportMoneyFromMinor(income, budget.plannedIncome.currency) }),
        items: validMonthlyRows.map((row) => {
          const amount = parseDollars(row.amount) ?? 0n;
          return {
            name: row.name.trim(),
            monthlyAmount: transportMoneyFromMinor(amount, budget.plannedIncome.currency),
            categoryId: row.categoryId || null,
            priority: Number(row.priority) || 0,
            isRequired: row.isRequired,
            rolloverPolicy: "positive" as const,
          };
        }),
      });
    },
    onSuccess: async () => {
      setBuildOpen(false);
      await invalidate();
    },
  });
  const createPeriod = useMutation({
    mutationFn: () => {
      const now = new Date();
      const start = now.toISOString().slice(0, 10);
      const end =
        apiView === "month"
          ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
              .toISOString()
              .slice(0, 10)
          : new Date(now.getTime() + 13 * 86_400_000).toISOString().slice(0, 10);
      return api.createBudget({
        periodKind: apiView,
        startDate: start,
        endDate: end,
        plannedIncome: transportMoney(0),
        envelopes: [],
      });
    },
    onSuccess: invalidate,
  });

  if (budgetQuery.isPending)
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Paycheck envelopes"
          title="Loading your budget"
          description="Reconciling funding and posted transaction activity."
        />
        <LoadingCard rows={6} />
      </Stack>
    );
  if (budgetQuery.isError)
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Paycheck envelopes"
          title="Budget unavailable"
          description="No allocation data was changed."
        />
        <ErrorState
          message="BetterWealth could not load this budget period."
          onRetry={() => budgetQuery.refetch()}
        />
      </Stack>
    );
  if (!budget)
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Paycheck envelopes"
          title="Start your first budget"
          description="Create a period, then turn monthly estimates into exact envelope targets."
        />
        {createPeriod.error instanceof Error ? (
          <Alert severity="error">{createPeriod.error.message}</Alert>
        ) : null}
        <EmptyState
          icon={<PaymentsRounded />}
          title={`No ${apiView === "month" ? "monthly" : "paycheck"} budget yet`}
          description="Create the period without inventing balances; you can enter income and spending targets next."
          actionLabel={createPeriod.isPending ? "Creating…" : "Create budget"}
          onAction={() => createPeriod.mutate()}
        />
      </Stack>
    );

  const totalPlanned =
    minor(budget.totalPlanned) ||
    budget.envelopes.reduce((sum, envelope) => sum + minor(envelope.planned), 0n);
  const surplus = budget.surplus
    ? minor(budget.surplus)
    : minor(budget.plannedIncome) - totalPlanned;
  const funded = minor(budget.funded);
  const spent = minor(budget.spent);
  const daysLeft = Math.max(
    0,
    Math.ceil(
      (new Date(`${budget.endDate.slice(0, 10)}T23:59:59`).getTime() - Date.now()) / 86_400_000,
    ),
  );
  const totalOverage = overages.reduce((sum, envelope) => sum - minor(envelope.available), 0n);
  const periodName = `${dateLabel(budget.startDate)}–${dateLabel(budget.endDate)}`;

  return (
    <Stack gap={5}>
      <PageHeader
        eyebrow="Paycheck envelopes"
        title="A job for every dollar"
        description={`${periodName}: ${overages.length ? `${overages.length} envelope${overages.length === 1 ? " needs" : "s need"} attention.` : "every funded envelope is at or above zero."}`}
        actions={
          <Button
            variant="contained"
            startIcon={<AccountBalanceWalletRounded />}
            onClick={() => setFundOpen(true)}
          >
            Fund paycheck
          </Button>
        }
      />
      {demo ? (
        <Alert severity="info">
          Demo mode is read-only. Every amount below is derived from the demo budget.
        </Alert>
      ) : null}
      <Card sx={{ p: 1 }}>
        <Tabs
          value={view}
          onChange={(_, value: typeof view) => setView(value)}
          variant="scrollable"
          scrollButtons={false}
          aria-label="Budget period"
        >
          <Tab value="paycheck" label="This paycheck" />
          <Tab value="month" label={dateLabel(budget.startDate, { month: "long" })} />
          <Tab value="plan" label="Plan" />
        </Tabs>
      </Card>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr 1fr", md: "repeat(5, 1fr)" },
          gap: 3,
        }}
      >
        <MetricCard
          label="Funded"
          value={<Money value={Number(funded) / 100} />}
          helper={`${percent(funded, totalPlanned)}% of plan`}
        />
        <MetricCard
          label="Spent"
          value={<Money value={Number(spent) / 100} />}
          helper={`${percent(spent, funded)}% of funded`}
        />
        <MetricCard
          label="Remaining"
          value={<Money value={dollars(budget.remaining)} />}
          helper={`Through ${dateLabel(budget.endDate)}`}
        />
        <MetricCard
          label="Unassigned"
          value={<Money value={dollars(budget.unassigned)} />}
          helper="Available to fund or move"
        />
        <MetricCard
          label={surplus >= 0n ? "Plan surplus" : "Plan gap"}
          value={<Money value={Number(surplus < 0n ? -surplus : surplus) / 100} />}
          helper={`${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}
        />
      </Box>
      {overages.length ? (
        <Alert
          severity="warning"
          icon={<WarningAmberRounded />}
          action={
            <Button color="inherit" onClick={() => openCover(overages[0]!)}>
              Fix now
            </Button>
          }
        >
          <strong>
            {overages.length === 1 ? overages[0]!.name : `${overages.length} envelopes`}{" "}
            {overages.length === 1 ? "is" : "are"} <Money value={Number(totalOverage) / 100} /> over
            available funding.
          </strong>{" "}
          Move only money that is actually unassigned or available elsewhere.
        </Alert>
      ) : (
        <Alert severity="success" icon={<CheckCircleRounded />}>
          No envelope is overspent in this period. Posted purchases and confirmed refunds are
          reflected.
        </Alert>
      )}
      <FundingPlan budget={budget} onEdit={() => setBuildOpen(true)} />
      <Box>
        <SectionHeader
          title="Envelopes"
          description="Available equals funding plus transfers and confirmed refunds, less posted spending. Pending and transfer transactions stay out."
          action={
            <Button
              variant="outlined"
              startIcon={<AddRounded />}
              onClick={() => {
                setEditor(emptyEditor);
                setEditorOpen(true);
              }}
            >
              New envelope
            </Button>
          }
        />
        {budget.envelopes.filter((envelope) => envelope.isActive !== false).length ? (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)", xl: "repeat(3, 1fr)" },
              gap: 4,
              mt: 4,
            }}
          >
            {budget.envelopes
              .filter((envelope) => envelope.isActive !== false)
              .map((envelope) => (
                <EnvelopeCard
                  key={envelope.id}
                  envelope={envelope}
                  onCover={() => openCover(envelope)}
                  onEdit={() => editEnvelope(envelope)}
                />
              ))}
          </Box>
        ) : (
          <Box sx={{ mt: 4 }}>
            <EmptyState
              icon={<PaymentsRounded />}
              title="No active envelopes"
              description="Add an envelope or build a complete plan from monthly spending estimates."
              actionLabel="Build plan"
              onAction={() => setBuildOpen(true)}
            />
          </Box>
        )}
      </Box>
      <Card
        sx={{
          background: (theme) =>
            `linear-gradient(135deg, ${alpha(theme.palette.secondary.main, 0.1)}, ${alpha(theme.palette.info.main, 0.06)})`,
        }}
      >
        <CardContent sx={{ p: { xs: 5, sm: 6 } }}>
          <Stack
            direction={{ xs: "column", md: "row" }}
            justifyContent="space-between"
            alignItems={{ xs: "stretch", md: "center" }}
            gap={4}
          >
            <Stack direction="row" gap={3} alignItems="flex-start">
              <Box
                sx={{
                  width: 44,
                  height: 44,
                  borderRadius: 3,
                  display: "grid",
                  placeItems: "center",
                  bgcolor: "background.paper",
                  color: "secondary.main",
                }}
              >
                <AutoAwesomeRounded />
              </Box>
              <Box>
                <Typography variant="h3">Build a realistic starting plan</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Enter monthly bills and spending estimates once. BetterWealth converts them into
                  exact per-paycheck targets using your pay frequency.
                </Typography>
              </Box>
            </Stack>
            <Button
              variant="outlined"
              endIcon={<ArrowForwardRounded />}
              onClick={() => setBuildOpen(true)}
            >
              Build from monthly spend
            </Button>
          </Stack>
        </CardContent>
      </Card>

      <Dialog open={coverOpen} onClose={() => setCoverOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Cover {selectedOverage?.name ?? "overspending"}</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">
            This records an explicit allocation transfer. It never rewrites a transaction.
          </Typography>
          <Stack gap={4} sx={{ mt: 5 }}>
            <FormControl fullWidth size="small">
              <InputLabel id="source-envelope">Move from</InputLabel>
              <Select
                labelId="source-envelope"
                value={sourceEnvelopeId}
                label="Move from"
                onChange={(event) => setSourceEnvelopeId(event.target.value)}
              >
                <MenuItem value="unassigned" disabled={minor(budget.unassigned) <= 0n}>
                  Unassigned income · <Money value={dollars(budget.unassigned)} />
                </MenuItem>
                {sourceOptions.map((envelope) => (
                  <MenuItem key={envelope.id} value={envelope.id}>
                    {envelope.name} · <Money value={dollars(envelope.available)} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              label="Amount"
              value={coverAmount}
              onChange={(event) => setCoverAmount(event.target.value)}
              error={coverAmount.length > 0 && !coverValid}
              helperText={
                coverAmount.length > 0 && !coverValid
                  ? "Enter an amount no greater than the source balance."
                  : "Exact to the cent."
              }
              InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
            />
            <Box sx={{ p: 3.5, bgcolor: "action.hover", borderRadius: 3 }}>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2">{selectedOverage?.name} after transfer</Typography>
                <Typography variant="body2" fontWeight={750}>
                  <Money
                    value={Number(minor(selectedOverage?.available) + (coverMinor ?? 0n)) / 100}
                  />
                </Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between" sx={{ mt: 2 }}>
                <Typography variant="body2">Source after transfer</Typography>
                <Typography variant="body2" fontWeight={750}>
                  <Money value={Number(sourceAvailable - (coverMinor ?? 0n)) / 100} />
                </Typography>
              </Stack>
            </Box>
          </Stack>
        </DialogContent>
        {allocation.error instanceof Error ? (
          <Alert severity="error" sx={{ mx: 3 }}>
            {allocation.error.message}
          </Alert>
        ) : null}
        <DialogActions>
          <Button onClick={() => setCoverOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!coverValid || allocation.isPending || demo}
            onClick={() => allocation.mutate()}
            startIcon={<SwapHorizRounded />}
          >
            {allocation.isPending
              ? "Transferring…"
              : `Transfer ${coverAmount ? `$${coverAmount}` : ""}`}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={fundOpen} onClose={() => setFundOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Fund {periodName}</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">
            Preview the deterministic allocation before committing. Required envelopes stay ahead of
            flexible spending.
          </Typography>
          <Box sx={{ mt: 5 }}>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2">Funding source</Typography>
              <Typography variant="h3">
                <Money value={Number(fundingAmount) / 100} />
              </Typography>
            </Stack>
            <Slider
              value={fundPercent}
              onChange={(_, value) => setFundPercent(value as number)}
              min={0}
              max={100}
              step={1}
              valueLabelDisplay="auto"
              valueLabelFormat={(value) => `${value}%`}
              aria-label="Percent of expected income to assign"
              sx={{ mt: 5 }}
            />
            <Stack gap={2} sx={{ mt: 2 }}>
              {fundingPreview.map(({ envelope, assigned }) => (
                <Stack key={envelope.id} direction="row" justifyContent="space-between">
                  <Stack direction="row" gap={2} alignItems="center">
                    <CheckCircleRounded
                      sx={{
                        color:
                          assigned === minor(envelope.planned) ? "success.main" : "text.disabled",
                        fontSize: 18,
                      }}
                    />
                    <Typography variant="body2">{envelope.name}</Typography>
                  </Stack>
                  <Typography variant="body2" fontWeight={700}>
                    <Money value={Number(assigned) / 100} />
                  </Typography>
                </Stack>
              ))}
            </Stack>
            <Divider sx={{ my: 3 }} />
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2">Assigned to envelopes</Typography>
              <Typography variant="body2" fontWeight={750}>
                <Money value={Number(previewAssigned) / 100} />
              </Typography>
            </Stack>
            <Stack direction="row" justifyContent="space-between" sx={{ mt: 1 }}>
              <Typography variant="body2">Left unassigned</Typography>
              <Typography variant="body2" fontWeight={750}>
                <Money value={Number(fundingAmount - previewAssigned) / 100} />
              </Typography>
            </Stack>
          </Box>
        </DialogContent>
        {fundBudget.error instanceof Error ? (
          <Alert severity="error" sx={{ mx: 3 }}>
            {fundBudget.error.message}
          </Alert>
        ) : null}
        <DialogActions>
          <Button onClick={() => setFundOpen(false)}>Review later</Button>
          <Button
            variant="contained"
            disabled={fundBudget.isPending || demo}
            onClick={() => fundBudget.mutate()}
          >
            {fundBudget.isPending ? "Committing…" : "Commit allocation"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={editorOpen} onClose={() => setEditorOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{editor.id ? `Edit ${editor.name}` : "New envelope"}</DialogTitle>
        <DialogContent>
          <Stack gap={3.5} sx={{ mt: 1 }}>
            <TextField
              autoFocus
              fullWidth
              label="Envelope name"
              value={editor.name}
              onChange={(event) => setEditor({ ...editor, name: event.target.value })}
            />
            <TextField
              fullWidth
              label={budget.periodKind === "month" ? "Monthly target" : "Target per paycheck"}
              value={editor.amount}
              onChange={(event) => setEditor({ ...editor, amount: event.target.value })}
              InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
              helperText="Use the amount you intend to reserve in this budget period."
            />
            <FormControl fullWidth size="small">
              <InputLabel id="envelope-category">Category match</InputLabel>
              <Select
                labelId="envelope-category"
                label="Category match"
                value={editor.categoryId}
                onChange={(event) => setEditor({ ...editor, categoryId: event.target.value })}
              >
                <MenuItem value="">No category fallback</MenuItem>
                {categories.map((category) => (
                  <MenuItem key={category.id} value={category.id}>
                    {category.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Stack direction={{ xs: "column", sm: "row" }} gap={3}>
              <TextField
                fullWidth
                label="Priority"
                type="number"
                value={editor.priority}
                onChange={(event) => setEditor({ ...editor, priority: event.target.value })}
                helperText="Higher numbers fund first."
              />
              <FormControl fullWidth size="small">
                <InputLabel id="rollover-policy">Rollover</InputLabel>
                <Select
                  labelId="rollover-policy"
                  label="Rollover"
                  value={editor.rolloverPolicy}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      rolloverPolicy: event.target.value as EnvelopeEditor["rolloverPolicy"],
                    })
                  }
                >
                  <MenuItem value="positive">Keep positive balance</MenuItem>
                  <MenuItem value="all">Keep gains and overages</MenuItem>
                  <MenuItem value="none">Reset each period</MenuItem>
                </Select>
              </FormControl>
            </Stack>
            <FormControlLabel
              control={
                <Checkbox
                  checked={editor.isRequired}
                  onChange={(event) => setEditor({ ...editor, isRequired: event.target.checked })}
                />
              }
              label="Required bill or essential spending"
            />
            <Divider />
            <TextField
              fullWidth
              label="Optional transaction rule"
              value={editor.matchText}
              onChange={(event) => setEditor({ ...editor, matchText: event.target.value })}
              helperText="Example: SPOTIFY. Saving creates a deterministic description-contains rule for this envelope."
            />
          </Stack>
        </DialogContent>
        {saveEnvelope.error instanceof Error ? (
          <Alert severity="error" sx={{ mx: 3 }}>
            {saveEnvelope.error.message}
          </Alert>
        ) : null}
        <DialogActions>
          {editor.id ? (
            <Button
              color="error"
              startIcon={<ArchiveRounded />}
              disabled={archiveEnvelope.isPending || demo}
              onClick={() => {
                if (editor.id) archiveEnvelope.mutate(editor.id);
              }}
              sx={{ mr: "auto" }}
            >
              Archive
            </Button>
          ) : null}
          <Button onClick={() => setEditorOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={
              !editor.name.trim() ||
              parseDollars(editor.amount) === null ||
              saveEnvelope.isPending ||
              demo
            }
            onClick={() => saveEnvelope.mutate()}
          >
            {saveEnvelope.isPending ? "Saving…" : "Save envelope"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={buildOpen} onClose={() => setBuildOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>Build from monthly spending</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">
            Monthly estimates are converted with exact integer cents: monthly × 12 ÷ paychecks per
            year. Existing envelopes with the same name are updated.
          </Typography>
          <Stack direction={{ xs: "column", sm: "row" }} gap={3} sx={{ mt: 5 }}>
            <FormControl fullWidth size="small">
              <InputLabel id="pay-frequency">Pay frequency</InputLabel>
              <Select
                labelId="pay-frequency"
                label="Pay frequency"
                value={paychecksPerYear}
                onChange={(event) => setPaychecksPerYear(event.target.value as 12 | 24 | 26 | 52)}
              >
                <MenuItem value={12}>Monthly · 12/year</MenuItem>
                <MenuItem value={24}>Twice monthly · 24/year</MenuItem>
                <MenuItem value={26}>Biweekly · 26/year</MenuItem>
                <MenuItem value={52}>Weekly · 52/year</MenuItem>
              </Select>
            </FormControl>
            <TextField
              fullWidth
              label="Approximate monthly take-home"
              value={monthlyIncome}
              onChange={(event) => setMonthlyIncome(event.target.value)}
              InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
              helperText="Optional; updates expected income."
            />
          </Stack>
          <Stack gap={3} sx={{ mt: 5 }}>
            {monthlyRows.map((row, index) => {
              const monthlyAmount = parseDollars(row.amount);
              const converted =
                monthlyAmount === null
                  ? null
                  : (monthlyAmount * 12n + BigInt(paychecksPerYear) / 2n) /
                    BigInt(paychecksPerYear);
              return (
                <Card variant="outlined" key={row.key}>
                  <CardContent sx={{ p: 3.5 }}>
                    <Stack
                      direction={{ xs: "column", md: "row" }}
                      gap={2}
                      alignItems={{ md: "flex-start" }}
                    >
                      <TextField
                        label="Envelope"
                        value={row.name}
                        onChange={(event) =>
                          setMonthlyRows((current) =>
                            current.map((item) =>
                              item.key === row.key ? { ...item, name: event.target.value } : item,
                            ),
                          )
                        }
                        sx={{ flex: 1.2 }}
                      />
                      <TextField
                        label="Monthly amount"
                        value={row.amount}
                        onChange={(event) =>
                          setMonthlyRows((current) =>
                            current.map((item) =>
                              item.key === row.key ? { ...item, amount: event.target.value } : item,
                            ),
                          )
                        }
                        InputProps={{
                          startAdornment: <InputAdornment position="start">$</InputAdornment>,
                        }}
                        helperText={
                          converted === null
                            ? "Enter dollars"
                            : `${new Intl.NumberFormat(undefined, { style: "currency", currency: budget.plannedIncome.currency }).format(Number(converted) / 100)} per paycheck`
                        }
                        sx={{ flex: 1 }}
                      />
                      <FormControl size="small" sx={{ flex: 1.1, minWidth: 150 }}>
                        <InputLabel id={`monthly-category-${row.key}`}>Category</InputLabel>
                        <Select
                          labelId={`monthly-category-${row.key}`}
                          label="Category"
                          value={row.categoryId}
                          onChange={(event) =>
                            setMonthlyRows((current) =>
                              current.map((item) =>
                                item.key === row.key
                                  ? { ...item, categoryId: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        >
                          <MenuItem value="">None</MenuItem>
                          {categories.map((category) => (
                            <MenuItem key={category.id} value={category.id}>
                              {category.name}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                      <TextField
                        label="Priority"
                        type="number"
                        value={row.priority}
                        onChange={(event) =>
                          setMonthlyRows((current) =>
                            current.map((item) =>
                              item.key === row.key
                                ? { ...item, priority: event.target.value }
                                : item,
                            ),
                          )
                        }
                        sx={{ width: { md: 110 } }}
                      />
                      <FormControlLabel
                        control={
                          <Checkbox
                            checked={row.isRequired}
                            onChange={(event) =>
                              setMonthlyRows((current) =>
                                current.map((item) =>
                                  item.key === row.key
                                    ? { ...item, isRequired: event.target.checked }
                                    : item,
                                ),
                              )
                            }
                          />
                        }
                        label="Required"
                      />
                      <IconButton
                        aria-label={`Remove row ${index + 1}`}
                        disabled={monthlyRows.length === 1}
                        onClick={() =>
                          setMonthlyRows((current) =>
                            current.filter((item) => item.key !== row.key),
                          )
                        }
                      >
                        <RemoveCircleOutlineRounded />
                      </IconButton>
                    </Stack>
                  </CardContent>
                </Card>
              );
            })}
          </Stack>
          <Button
            startIcon={<AddRounded />}
            onClick={() =>
              setMonthlyRows((rows) => [
                ...rows,
                {
                  key: Math.max(0, ...rows.map((row) => row.key)) + 1,
                  name: "",
                  amount: "",
                  categoryId: "",
                  priority: "100",
                  isRequired: false,
                },
              ])
            }
            sx={{ mt: 3 }}
          >
            Add spending line
          </Button>
        </DialogContent>
        {buildPlan.error instanceof Error ? (
          <Alert severity="error" sx={{ mx: 3 }}>
            {buildPlan.error.message}
          </Alert>
        ) : null}
        <DialogActions>
          <Button onClick={() => setBuildOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!validMonthlyRows.length || buildPlan.isPending || demo}
            onClick={() => buildPlan.mutate()}
          >
            {buildPlan.isPending
              ? "Building…"
              : `Build ${validMonthlyRows.length} envelope${validMonthlyRows.length === 1 ? "" : "s"}`}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
