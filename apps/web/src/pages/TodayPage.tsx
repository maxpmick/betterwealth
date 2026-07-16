import {
  ArrowForwardRounded,
  AutoAwesomeRounded,
  CalendarMonthRounded,
  CheckCircleRounded,
  DragIndicatorRounded,
  ExpandMoreRounded,
  FlagRounded,
  ReceiptLongRounded,
  ScheduleRounded,
  ShieldRounded,
  TrendingUpRounded,
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
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  List,
  ListItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@mui/material";
import { LineChart } from "@mui/x-charts/LineChart";
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import {
  type ApiBill,
  type ApiEnvelope,
  type ApiGoal,
  type ApiGoalContribution,
  type ApiTransaction,
  api,
  type CursorPage,
  type DashboardReport,
  type NetWorthReport,
} from "../api";
import { Stack, Typography } from "../components/mui";
import {
  ChartMaskedState,
  EmptyState,
  ErrorState,
  HelpTip,
  LoadingCard,
  Money,
  PageHeader,
  ProgressMeter,
  SectionHeader,
  StatusChip,
  TrustStatePanel,
} from "../components/ui";
import { usePrivacy } from "../contexts";
import {
  envelopes as demoEnvelopeData,
  goals as demoGoalData,
  netWorthHistory,
  recentActivity,
} from "../data";
import { isDemoMode } from "../demo";

const demoDashboard: DashboardReport = {
  safeToSpend: { minorUnits: "61200", currency: "USD" },
  safePerDay: { minorUnits: "4371", currency: "USD" },
  coveredThrough: "2026-07-30T23:59:59.999Z",
  coveredThroughSource: "income_source",
  availableCash: { minorUnits: "300000", currency: "USD" },
  reservedBills: { minorUnits: "84800", currency: "USD" },
  envelopeCommitments: { minorUnits: "34000", currency: "USD" },
  goalContributions: { minorUnits: "20000", currency: "USD" },
  minimumBuffer: { minorUnits: "100000", currency: "USD" },
  projectedLiquidNetWorth: { minorUnits: "22340000", currency: "USD" },
  targetLiquidNetWorth: { minorUnits: "22500000", currency: "USD" },
  targetAge: 30,
  projectionSource: "forecast",
  savingsRate: 24.6,
  trust: {
    state: "ready",
    asOf: "2026-07-16T10:42:00.000Z",
    pendingImpact: { minorUnits: "-4816", currency: "USD" },
    missingInputs: [],
    confidenceLabel: "High",
  },
};

const demoEnvelopes: CursorPage<ApiEnvelope> = {
  data: demoEnvelopeData.map((envelope, index) => ({
    id: `demo-envelope-${index}`,
    name: envelope.name,
    planned: asMoney(envelope.planned),
    funded: asMoney(envelope.funded),
    activity: asMoney(envelope.activity),
    available: asMoney(envelope.available),
    cadence: envelope.cadence,
    pacing: envelope.pacing === "on-track" ? "on_track" : envelope.pacing,
    rolloverPolicy: "reset",
  })),
  page: { cursor: null, hasMore: false },
};

const demoTransactions: CursorPage<ApiTransaction> = {
  data: recentActivity.map((transaction, index) => ({
    id: transaction.id,
    effectiveDate: new Date(2026, 6, 16 - index).toISOString(),
    description: transaction.rawDescription,
    merchant: transaction.merchant,
    amount: asMoney(transaction.amount),
    accountName: transaction.account,
    categoryName: transaction.category,
    status: transaction.pending ? "pending" : "posted",
    reviewState: transaction.needsReview ? "needs_review" : "ready",
    source: "simplefin",
    tags: [],
  })),
  page: { cursor: null, hasMore: false },
};

const demoBills: CursorPage<ApiBill> = {
  data: [
    {
      id: "bill-internet",
      name: "Home internet",
      amountMin: asMoney(65),
      amountMax: asMoney(65),
      recurrenceConfidenceBps: 9800,
      nextDueDate: "2026-07-21",
      dueRule: { cadence: "monthly" },
      isRequired: true,
      isActive: true,
    },
    {
      id: "bill-card",
      name: "Emerald card",
      amountMin: asMoney(410),
      amountMax: asMoney(410),
      recurrenceConfidenceBps: 8000,
      nextDueDate: "2026-07-24",
      dueRule: { cadence: "monthly" },
      isRequired: true,
      isActive: true,
    },
    {
      id: "bill-insurance",
      name: "Renter’s insurance",
      amountMin: asMoney(28),
      amountMax: asMoney(28),
      recurrenceConfidenceBps: 9900,
      nextDueDate: "2026-07-27",
      dueRule: { cadence: "monthly" },
      isRequired: true,
      isActive: true,
    },
  ],
  page: { cursor: null, hasMore: false },
};

const demoNetWorth: NetWorthReport = {
  total: asMoney(19_800),
  liquid: asMoney(16_300),
  investable: asMoney(14_500),
  retirement: asMoney(8_000),
  assets: asMoney(34_000),
  debts: asMoney(13_200),
  series: netWorthHistory.map((point, index) => ({
    date: `2026-${String(index + 1).padStart(2, "0")}-01`,
    total: asMoney(point.total),
    liquid: asMoney(point.liquid),
  })),
  composition: [],
};

const demoGoals: CursorPage<ApiGoal> = {
  data: demoGoalData.map((goal, index) => ({
    id: goal.id,
    name: goal.name,
    type:
      index === 0
        ? "emergency_fund"
        : index === 1
          ? "purchase"
          : index === 2
            ? "debt_payoff"
            : "investment",
    target: asMoney(goal.target),
    funded: asMoney(goal.funded),
    monthlyContribution: asMoney(goal.monthly),
    earliestSafeDate: goal.safeDate,
    probability: goal.probability,
    priority: index + 1,
    paused: false,
  })),
  page: { cursor: null, hasMore: false },
};

function asMoney(amount: number, currency = "USD") {
  return { minorUnits: String(Math.round(amount * 100)), currency };
}

function minor(money: { minorUnits: string }) {
  return Number(money.minorUnits) / 100;
}

function formatDate(value: string, options: Intl.DateTimeFormatOptions) {
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? "Date not set" : date.toLocaleDateString("en-US", options);
}

function daysThrough(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 86_400_000));
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function localIsoDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function deriveWeeklyGoalAction(
  goal: ApiGoal | undefined,
  reservedForGoals: { minorUnits: string },
  contributions: readonly ApiGoalContribution[],
  today = new Date(),
) {
  if (!goal) {
    return { suggestedMinorUnits: "0", remainingMinorUnits: "0", recordedMinorUnits: "0" };
  }
  const remaining = BigInt(goal.target.minorUnits) - BigInt(goal.funded.minorUnits);
  const weeklyPace = (BigInt(goal.monthlyContribution.minorUnits) * 12n) / 52n;
  const start = new Date(today);
  const day = start.getDay();
  start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
  const startDate = localIsoDate(start);
  const endDate = localIsoDate(today);
  const recorded = contributions.reduce(
    (total, contribution) =>
      contribution.goalId === goal.id &&
      contribution.contributedOn >= startDate &&
      contribution.contributedOn <= endDate
        ? total + BigInt(contribution.amount.minorUnits)
        : total,
    0n,
  );
  const paceRemaining = weeklyPace > recorded ? weeklyPace - recorded : 0n;
  const reserve = BigInt(reservedForGoals.minorUnits);
  const suggested = [remaining, paceRemaining, reserve].reduce((lowest, value) =>
    value < lowest ? value : lowest,
  );
  return {
    suggestedMinorUnits: (suggested > 0n ? suggested : 0n).toString(),
    remainingMinorUnits: (remaining > 0n ? remaining : 0n).toString(),
    recordedMinorUnits: recorded.toString(),
  };
}

function SafeToSpendHero({
  report,
  goal,
  contributions,
  actionLoading,
  actionError,
  readOnly,
  onContribute,
  contributionPending,
  contributionError,
}: {
  report: DashboardReport;
  goal: ApiGoal | undefined;
  contributions: readonly ApiGoalContribution[];
  actionLoading: boolean;
  actionError: boolean;
  readOnly: boolean;
  onContribute: (goal: ApiGoal, amountMinorUnits: string) => Promise<void>;
  contributionPending: boolean;
  contributionError: string | undefined;
}) {
  const [impactOpen, setImpactOpen] = useState(false);
  const action = deriveWeeklyGoalAction(goal, report.goalContributions, contributions);
  const suggested = Number(action.suggestedMinorUnits) / 100;
  const remaining = Number(action.remainingMinorUnits) / 100;
  const recorded = Number(action.recordedMinorUnits) / 100;
  const hasAction = Boolean(goal && BigInt(action.suggestedMinorUnits) > 0n && !actionError);
  const rawSafeToSpend =
    BigInt(report.availableCash.minorUnits) -
    BigInt(report.reservedBills.minorUnits) -
    BigInt(report.envelopeCommitments.minorUnits) -
    BigInt(report.goalContributions.minorUnits) -
    BigInt(report.minimumBuffer.minorUnits);
  return (
    <Card
      sx={{
        color: "#fff",
        overflow: "hidden",
        border: 0,
        position: "relative",
        background: "linear-gradient(122deg, #1B3354 0%, #23546A 57%, #188161 122%)",
        boxShadow: "0 28px 62px rgba(27,72,82,.24)",
      }}
    >
      <Box
        aria-hidden
        sx={{
          position: "absolute",
          width: 320,
          height: 320,
          borderRadius: "50%",
          right: -110,
          top: -165,
          border: "1px solid rgba(255,255,255,.09)",
          boxShadow: "0 0 0 55px rgba(255,255,255,.025), 0 0 0 110px rgba(255,255,255,.018)",
        }}
      />
      <CardContent
        sx={{ position: "relative", p: { xs: 5, sm: 7 }, "&:last-child": { pb: { xs: 5, sm: 7 } } }}
      >
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={3}>
          <Box>
            <Stack direction="row" alignItems="center" gap={1.5}>
              <Typography sx={{ color: "rgba(255,255,255,.72)", fontWeight: 650 }}>
                Safe to spend
              </Typography>
              <HelpTip
                title={
                  report.coveredThroughSource === "income_source"
                    ? "Cash available through your next paycheck after bills, envelopes, goals, and your minimum buffer."
                    : "Cash available through a temporary 14-day planning window after bills, envelopes, goals, and your minimum buffer. Add the next payday to make this a pay-cycle number."
                }
              />
            </Stack>
            <Typography
              sx={{
                mt: 2,
                fontSize: { xs: "3rem", sm: "4rem" },
                lineHeight: 1,
                fontWeight: 760,
                letterSpacing: "-0.055em",
              }}
            >
              <Money value={minor(report.safeToSpend)} currency={report.safeToSpend.currency} />
            </Typography>
            <Typography sx={{ mt: 2, color: "rgba(255,255,255,.74)" }}>
              <Money value={minor(report.safePerDay)} currency={report.safePerDay.currency} /> per
              day ·{" "}
              {report.coveredThroughSource === "income_source" ? "covered" : "planning window"}{" "}
              through {formatDate(report.coveredThrough, { month: "short", day: "numeric" })}
            </Typography>
          </Box>
          <Box sx={{ alignSelf: { xs: "flex-start", sm: "flex-end" } }}>
            <StatusChip
              label={
                report.trust.state === "ready"
                  ? "Ready to use"
                  : report.trust.state === "stale"
                    ? "Stale snapshot"
                    : "Setup incomplete"
              }
              tone={
                report.trust.state === "ready"
                  ? "positive"
                  : report.trust.state === "stale"
                    ? "risk"
                    : "warning"
              }
            />
          </Box>
        </Stack>
        <Accordion
          disableGutters
          elevation={0}
          sx={{
            mt: 6,
            color: "#fff",
            bgcolor: "rgba(255,255,255,.08)",
            border: "1px solid rgba(255,255,255,.12)",
            "&::before": { display: "none" },
          }}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreRounded sx={{ color: "#fff" }} />}
            aria-controls="safe-formula-content"
            id="safe-formula-header"
          >
            <Stack direction="row" gap={2} alignItems="center">
              <ShieldRounded sx={{ fontSize: 19, color: "#69DEB4" }} />
              <Typography variant="body2" fontWeight={700}>
                Show how this is calculated
              </Typography>
            </Stack>
          </AccordionSummary>
          <AccordionDetails id="safe-formula-content">
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr 1fr", sm: "repeat(5, 1fr)" },
                gap: 3,
              }}
            >
              {[
                ["Available cash", minor(report.availableCash), "+"],
                ["Reserved bills", minor(report.reservedBills), "−"],
                ["Envelopes", minor(report.envelopeCommitments), "−"],
                ["Goals", minor(report.goalContributions), "−"],
                ["Min. buffer", minor(report.minimumBuffer), "−"],
              ].map(([label, value, operator]) => (
                <Box key={String(label)}>
                  <Typography variant="caption" sx={{ color: "rgba(255,255,255,.6)" }}>
                    {operator} {label}
                  </Typography>
                  <Typography fontWeight={720} sx={{ mt: 0.5 }}>
                    <Money value={Number(value)} currency={report.safeToSpend.currency} />
                  </Typography>
                </Box>
              ))}
            </Box>
            <Divider sx={{ my: 3, borderColor: "rgba(255,255,255,.14)" }} />
            <Typography variant="body2" sx={{ color: "rgba(255,255,255,.72)" }}>
              {rawSafeToSpend < 0n ? (
                <>
                  The raw formula is{" "}
                  <Money
                    value={Number(rawSafeToSpend) / 100}
                    currency={report.safeToSpend.currency}
                  />
                  . Safe to spend is deliberately floored at{" "}
                  <Money value={0} currency={report.safeToSpend.currency} />.
                </>
              ) : (
                <>
                  These five terms reconcile exactly to{" "}
                  <Money value={minor(report.safeToSpend)} currency={report.safeToSpend.currency} />
                  .
                </>
              )}
            </Typography>
          </AccordionDetails>
        </Accordion>
        <Box
          sx={{
            mt: 4,
            p: { xs: 3.5, sm: 4 },
            borderRadius: 3,
            bgcolor: "rgba(8,22,29,.22)",
            border: "1px solid rgba(255,255,255,.1)",
          }}
        >
          <Stack
            direction={{ xs: "column", sm: "row" }}
            alignItems={{ xs: "stretch", sm: "center" }}
            justifyContent="space-between"
            gap={3}
          >
            <Stack direction="row" gap={2.5} alignItems="flex-start">
              <Box
                sx={{
                  width: 38,
                  height: 38,
                  borderRadius: 2.5,
                  display: "grid",
                  placeItems: "center",
                  flex: "0 0 auto",
                  bgcolor: "rgba(255,255,255,.12)",
                }}
              >
                {hasAction ? (
                  <AutoAwesomeRounded sx={{ fontSize: 20 }} />
                ) : (
                  <ShieldRounded sx={{ fontSize: 20 }} />
                )}
              </Box>
              <Box>
                <Typography variant="body2" fontWeight={750}>
                  {actionLoading ? (
                    "Calculating this week’s action…"
                  ) : actionError ? (
                    "Weekly recommendation unavailable"
                  ) : hasAction ? (
                    <>
                      This week: earmark{" "}
                      <Money value={suggested} currency={report.safeToSpend.currency} /> for{" "}
                      {goal?.name}
                    </>
                  ) : goal && recorded > 0 ? (
                    <>This week’s pace for {goal.name} is already recorded</>
                  ) : goal && BigInt(goal.monthlyContribution.minorUnits) === 0n ? (
                    `${goal.name} needs a contribution pace before it can be scheduled`
                  ) : goal && BigInt(report.goalContributions.minorUnits) === 0n ? (
                    "No goal money is reserved in this pay cycle"
                  ) : goal ? (
                    `${goal.name} has no remaining weekly action`
                  ) : (
                    "Set a goal to give your surplus a job"
                  )}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{ display: "block", mt: 0.75, color: "rgba(255,255,255,.65)" }}
                >
                  {hasAction
                    ? "Capped by the goal’s annualized weekly pace, remaining target, and money already reserved for goals."
                    : actionError
                      ? "Your safe-to-spend amount is still valid; only the optional action history could not be verified."
                      : goal && recorded > 0
                        ? "Recorded contributions prevent BetterWealth from suggesting the same weekly step twice."
                        : "BetterWealth will recommend a weekly earmark once an active goal has a target, a pace, and reserved funding."}
                </Typography>
              </Box>
            </Stack>
            {hasAction ? (
              <Button
                color="inherit"
                variant="outlined"
                endIcon={<ArrowForwardRounded />}
                onClick={() => setImpactOpen(true)}
                sx={{ color: "#fff", borderColor: "rgba(255,255,255,.25)", whiteSpace: "nowrap" }}
              >
                Preview impact
              </Button>
            ) : !goal && !actionError ? (
              <Button
                component={RouterLink}
                to="/goals?action=add"
                color="inherit"
                variant="outlined"
                endIcon={<ArrowForwardRounded />}
                sx={{ color: "#fff", borderColor: "rgba(255,255,255,.25)", whiteSpace: "nowrap" }}
              >
                Create a goal
              </Button>
            ) : null}
          </Stack>
        </Box>
        {contributionError ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {contributionError}
          </Alert>
        ) : null}
      </CardContent>
      <Dialog open={impactOpen} onClose={() => setImpactOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Preview weekly action</DialogTitle>
        <DialogContent>
          <Stack gap={3} sx={{ mt: 1 }}>
            <Typography color="text.secondary">
              This records an allocation toward {goal?.name}. It does not move money at your bank or
              rewrite an imported transaction.
            </Typography>
            <Box sx={{ p: 4, bgcolor: "action.hover", borderRadius: 3 }}>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2">Contribution</Typography>
                <Typography variant="body2" fontWeight={750}>
                  <Money value={suggested} currency={report.safeToSpend.currency} />
                </Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between" sx={{ mt: 2 }}>
                <Typography variant="body2">Already recorded this week</Typography>
                <Typography variant="body2" fontWeight={750}>
                  <Money value={recorded} currency={report.safeToSpend.currency} />
                </Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between" sx={{ mt: 2 }}>
                <Typography variant="body2">Goal remaining afterward</Typography>
                <Typography variant="body2" fontWeight={750}>
                  <Money
                    value={Math.max(0, remaining - suggested)}
                    currency={report.safeToSpend.currency}
                  />
                </Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between" sx={{ mt: 2 }}>
                <Typography variant="body2">Safe-to-spend afterward</Typography>
                <Typography variant="body2" fontWeight={750}>
                  <Money value={minor(report.safeToSpend)} currency={report.safeToSpend.currency} />
                </Typography>
              </Stack>
            </Box>
            <Alert severity="info">
              Safe to spend stays unchanged because this amount is already included in the goal
              reserve shown in the formula.
            </Alert>
            {readOnly ? (
              <Alert severity="warning">
                This is a fictional demo preview. No contribution will be recorded.
              </Alert>
            ) : null}
            {contributionError ? <Alert severity="error">{contributionError}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImpactOpen(false)}>Not now</Button>
          <Button
            variant="contained"
            disabled={!goal || contributionPending || readOnly}
            onClick={async () => {
              if (!goal) return;
              try {
                await onContribute(goal, action.suggestedMinorUnits);
                setImpactOpen(false);
              } catch {
                // The mutation error remains visible in this preview.
              }
            }}
          >
            {readOnly ? "Demo preview only" : contributionPending ? "Saving…" : "Record earmark"}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

function SignalCard({
  icon,
  title,
  value,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  value: React.ReactNode;
  detail: string;
  tone: string;
}) {
  return (
    <Card>
      <CardContent sx={{ p: 4.5 }}>
        <Stack direction="row" gap={2.5} alignItems="flex-start">
          <Box
            sx={{
              width: 38,
              height: 38,
              borderRadius: 2.5,
              display: "grid",
              placeItems: "center",
              bgcolor: alpha(tone, 0.12),
              color: tone,
            }}
          >
            {icon}
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary">
              {title}
            </Typography>
            <Typography component="div" variant="h3" sx={{ mt: 0.5 }}>
              {value}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {detail}
            </Typography>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

function WealthChart({
  query,
  range,
  onRangeChange,
}: {
  query: UseQueryResult<NetWorthReport | undefined, Error>;
  range: string;
  onRangeChange: (range: string) => void;
}) {
  const { privacyEnabled } = usePrivacy();
  const history =
    query.data?.series.map((row) => ({
      month: formatDate(row.date, { month: "short", year: "2-digit" }),
      total: minor(row.total),
      liquid: minor(row.liquid),
    })) ?? [];
  if (query.isPending) return <LoadingCard rows={4} />;
  if (query.isError || !query.data)
    return (
      <Card>
        <CardContent sx={{ p: 5 }}>
          <ErrorState
            message="Net-worth history could not be loaded."
            onRetry={() => query.refetch()}
          />
        </CardContent>
      </Card>
    );
  const currency = query.data.total.currency;
  return (
    <Card sx={{ minWidth: 0 }}>
      <CardContent sx={{ p: { xs: 4, sm: 5 } }}>
        <SectionHeader
          title="Net-worth momentum"
          description={
            history.length > 1
              ? `${history.length} dated account and valuation snapshots are included.`
              : "Add or sync more than one dated snapshot to reveal momentum."
          }
          action={
            <Stack direction="row">
              {["3M", "1Y", "All"].map((item) => (
                <Button
                  key={item}
                  size="small"
                  color={range === item ? "primary" : "inherit"}
                  onClick={() => onRangeChange(item)}
                  sx={{ minWidth: 44 }}
                >
                  {item}
                </Button>
              ))}
            </Stack>
          }
        />
        {history.length ? (
          <>
            <Box sx={{ mt: 3, minWidth: 0 }}>
              {privacyEnabled ? (
                <ChartMaskedState />
              ) : (
                <LineChart
                  height={270}
                  dataset={history}
                  xAxis={[
                    { dataKey: "month", scaleType: "point", tickLabelStyle: { fontSize: 11 } },
                  ]}
                  yAxis={[
                    {
                      valueFormatter: (value: number) => `$${Math.round(Number(value) / 1000)}k`,
                      width: 48,
                    },
                  ]}
                  series={[
                    {
                      dataKey: "total",
                      label: "Total net worth",
                      color: "#1F3A5F",
                      area: true,
                      showMark: false,
                      valueFormatter: (value) => `$${Number(value ?? 0).toLocaleString()}`,
                    },
                    {
                      dataKey: "liquid",
                      label: "Liquid net worth",
                      color: "#1F9D72",
                      showMark: false,
                      valueFormatter: (value) => `$${Number(value ?? 0).toLocaleString()}`,
                    },
                  ]}
                  grid={{ horizontal: true }}
                  margin={{ left: 4, right: 12, top: 18, bottom: 4 }}
                  slotProps={{ legend: { position: { vertical: "bottom", horizontal: "center" } } }}
                />
              )}
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              {privacyEnabled
                ? "Chart values are hidden."
                : `Summary: total net worth moved from ${new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(history[0]?.total ?? 0)} to ${new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(history.at(-1)?.total ?? 0)}.`}
            </Typography>
            <Accordion
              disableGutters
              elevation={0}
              sx={{ mt: 2, border: 0, "&::before": { display: "none" } }}
            >
              <AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ px: 0 }}>
                <Typography variant="body2" fontWeight={700}>
                  View chart data table
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 0, overflowX: "auto" }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Snapshot</TableCell>
                      <TableCell align="right">Total</TableCell>
                      <TableCell align="right">Liquid</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {history.map((row, index) => (
                      <TableRow key={`${row.month}-${index}`}>
                        <TableCell>{row.month}</TableCell>
                        <TableCell align="right">
                          <Money value={row.total} currency={currency} />
                        </TableCell>
                        <TableCell align="right">
                          <Money value={row.liquid} currency={currency} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </AccordionDetails>
            </Accordion>
          </>
        ) : (
          <EmptyState
            icon={<TrendingUpRounded />}
            title="No wealth history yet"
            description="Sync an account or add a manual valuation to create your first dated snapshot."
            actionLabel="Open accounts"
            onAction={() => {
              window.location.href = "/accounts";
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function EnvelopeGrid({
  query,
}: {
  query: UseQueryResult<CursorPage<ApiEnvelope> | undefined, Error>;
}) {
  if (query.isPending) return <LoadingCard rows={4} />;
  if (query.isError || !query.data)
    return (
      <Card>
        <CardContent sx={{ p: 5 }}>
          <ErrorState
            message="Envelope pacing could not be loaded."
            onRetry={() => query.refetch()}
          />
        </CardContent>
      </Card>
    );
  const active = query.data.data.slice(0, 6);
  const attention = active.filter((envelope) => envelope.pacing !== "on_track").length;
  return (
    <Card>
      <CardContent sx={{ p: { xs: 4, sm: 5 } }}>
        <SectionHeader
          title="Envelope pace"
          description={
            active.length
              ? `${attention} of ${active.length} envelopes ${attention === 1 ? "needs" : "need"} attention.`
              : "No funded envelopes are available for this period."
          }
          action={
            <Button component={RouterLink} to="/budget" endIcon={<ArrowForwardRounded />}>
              Open budget
            </Button>
          }
        />
        {active.length ? (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)" },
              gap: 3,
              mt: 5,
            }}
          >
            {active.map((envelope) => {
              const funded = minor(envelope.funded);
              const activity = Math.abs(minor(envelope.activity));
              const used = funded ? (activity / funded) * 100 : 0;
              const tone =
                envelope.pacing === "over"
                  ? "#DD625B"
                  : envelope.pacing === "watch"
                    ? "#D98B2B"
                    : "#1F9D72";
              return (
                <Box
                  key={envelope.id}
                  sx={{ p: 3.5, border: "1px solid", borderColor: "divider", borderRadius: 3 }}
                >
                  <Stack direction="row" justifyContent="space-between" gap={2}>
                    <Typography variant="body2" fontWeight={700}>
                      {envelope.name}
                    </Typography>
                    <Typography variant="body2" fontWeight={750}>
                      <Money
                        value={minor(envelope.available)}
                        currency={envelope.available.currency}
                      />
                    </Typography>
                  </Stack>
                  <ProgressMeter value={used} color={tone} label={`${envelope.name} budget used`} />
                  <Stack direction="row" justifyContent="space-between" sx={{ mt: 1.5 }}>
                    <Typography variant="caption" color="text.secondary">
                      <Money value={activity} currency={envelope.activity.currency} /> spent
                    </Typography>
                    <StatusChip
                      label={
                        envelope.pacing === "on_track"
                          ? "On pace"
                          : envelope.pacing === "watch"
                            ? "Watch"
                            : "Over plan"
                      }
                      tone={
                        envelope.pacing === "on_track"
                          ? "positive"
                          : envelope.pacing === "watch"
                            ? "warning"
                            : "risk"
                      }
                    />
                  </Stack>
                </Box>
              );
            })}
          </Box>
        ) : (
          <Box sx={{ mt: 3 }}>
            <EmptyState
              icon={<FlagRounded />}
              title="No envelopes yet"
              description="Create a pay-cycle budget to see what is available and what needs attention."
              actionLabel="Create a budget"
              onAction={() => {
                window.location.href = "/budget";
              }}
            />
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityAndBills({
  transactionsQuery,
  billsQuery,
  report,
}: {
  transactionsQuery: UseQueryResult<CursorPage<ApiTransaction> | undefined, Error>;
  billsQuery: UseQueryResult<CursorPage<ApiBill> | undefined, Error>;
  report: DashboardReport;
}) {
  const recent = transactionsQuery.data?.data.slice(0, 5) ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const through = report.coveredThrough.slice(0, 10);
  const upcoming = (billsQuery.data?.data ?? [])
    .filter(
      (bill) =>
        bill.isActive &&
        bill.nextDueDate &&
        bill.nextDueDate >= today &&
        bill.nextDueDate <= through,
    )
    .slice(0, 5);
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "1.25fr .75fr" }, gap: 4 }}>
      <Card>
        <CardContent sx={{ p: { xs: 4, sm: 5 } }}>
          <SectionHeader
            title="Recent activity"
            description={
              transactionsQuery.isPending
                ? "Loading your latest ledger entries…"
                : recent.length
                  ? `${recent.filter((item) => item.reviewState === "needs_review").length} of the latest ${recent.length} need review.`
                  : "No imported or manual transactions yet."
            }
            action={
              <Button component={RouterLink} to="/transactions">
                View all
              </Button>
            }
          />
          {transactionsQuery.isPending ? (
            <Box sx={{ mt: 3 }}>
              <LoadingCard rows={3} />
            </Box>
          ) : transactionsQuery.isError ? (
            <Box sx={{ mt: 3 }}>
              <ErrorState
                message="Recent transactions could not be loaded."
                onRetry={() => transactionsQuery.refetch()}
              />
            </Box>
          ) : recent.length ? (
            <List disablePadding sx={{ mt: 3 }}>
              {recent.map((item, index) => (
                <ListItem
                  key={item.id}
                  disableGutters
                  divider={index !== recent.length - 1}
                  sx={{ py: 2.5, gap: 2 }}
                >
                  <Box
                    sx={{
                      width: 38,
                      height: 38,
                      borderRadius: 2.5,
                      display: "grid",
                      placeItems: "center",
                      flex: "0 0 auto",
                      bgcolor:
                        item.reviewState === "needs_review"
                          ? alpha("#D98B2B", 0.12)
                          : "action.hover",
                      color:
                        item.reviewState === "needs_review" ? "warning.main" : "text.secondary",
                    }}
                  >
                    {item.reviewState === "needs_review" ? (
                      <WarningAmberRounded fontSize="small" />
                    ) : (
                      <ReceiptLongRounded fontSize="small" />
                    )}
                  </Box>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="body2" fontWeight={700} noWrap>
                      {item.merchant || item.description}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {item.categoryName} · {item.accountName}
                    </Typography>
                  </Box>
                  <Box sx={{ textAlign: "right" }}>
                    <Typography variant="body2" fontWeight={750}>
                      <Money value={minor(item.amount)} currency={item.amount.currency} sign />
                    </Typography>
                    {item.reviewState === "needs_review" ? (
                      <Typography variant="caption" color="warning.main">
                        Review
                      </Typography>
                    ) : item.status === "pending" ? (
                      <Typography variant="caption" color="text.secondary">
                        Pending
                      </Typography>
                    ) : null}
                  </Box>
                </ListItem>
              ))}
            </List>
          ) : (
            <EmptyState
              icon={<ReceiptLongRounded />}
              title="Your ledger is empty"
              description="Connect SimpleFIN or add a manual transaction to start tracing where your money goes."
              actionLabel="Open transactions"
              onAction={() => {
                window.location.href = "/transactions";
              }}
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent sx={{ p: { xs: 4, sm: 5 } }}>
          <SectionHeader
            title={
              report.coveredThroughSource === "income_source" ? "Before payday" : "Planning window"
            }
            description={`${report.coveredThroughSource === "income_source" ? "Covered" : "Temporary window"} through ${formatDate(report.coveredThrough, { month: "short", day: "numeric" })}`}
          />
          {billsQuery.isPending ? (
            <Box sx={{ mt: 4 }}>
              <LoadingCard rows={3} />
            </Box>
          ) : billsQuery.isError ? (
            <Box sx={{ mt: 4 }}>
              <ErrorState
                message="Upcoming bills could not be loaded."
                onRetry={() => billsQuery.refetch()}
              />
            </Box>
          ) : upcoming.length ? (
            <Stack gap={3} sx={{ mt: 5 }}>
              {upcoming.map((bill) => (
                <Stack key={bill.id} direction="row" alignItems="center" gap={2}>
                  <Box
                    sx={{
                      width: 40,
                      height: 40,
                      borderRadius: 2.5,
                      display: "grid",
                      placeItems: "center",
                      bgcolor: "action.hover",
                    }}
                  >
                    <CalendarMonthRounded sx={{ fontSize: 19, color: "text.secondary" }} />
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={700} noWrap>
                      {bill.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {formatDate(bill.nextDueDate ?? "", { month: "short", day: "numeric" })}
                      {bill.autopayAccountId ? " · autopay" : bill.isRequired ? " · required" : ""}
                    </Typography>
                  </Box>
                  <Typography variant="body2" fontWeight={750}>
                    <Money value={minor(bill.amountMax)} currency={bill.amountMax.currency} />
                  </Typography>
                </Stack>
              ))}
            </Stack>
          ) : (
            <Box sx={{ py: 6, textAlign: "center" }}>
              <CheckCircleRounded color="success" />
              <Typography variant="subtitle1" sx={{ mt: 2 }}>
                {report.coveredThroughSource === "income_source"
                  ? "No bills due before payday"
                  : "No bills due in this planning window"}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Only active bills with confirmed due dates appear here.
              </Typography>
            </Box>
          )}
          <Divider sx={{ my: 4 }} />
          <Stack direction="row" justifyContent="space-between" gap={2}>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Reserved for bills
              </Typography>
              <Typography variant="h3" sx={{ mt: 0.5 }}>
                <Money
                  value={minor(report.reservedBills)}
                  currency={report.reservedBills.currency}
                />
              </Typography>
            </Box>
            <StatusChip
              label={`${daysThrough(report.coveredThrough)} days ${report.coveredThroughSource === "income_source" ? "covered" : "modeled"}`}
              tone={report.coveredThroughSource === "income_source" ? "positive" : "warning"}
            />
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

export function TodayPage() {
  const demo = isDemoMode();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: api.dashboard,
    initialData: demo ? demoDashboard : undefined,
    enabled: !demo,
    retry: 1,
    staleTime: 60_000,
  });
  const envelopesQuery = useQuery({
    queryKey: ["envelopes"],
    queryFn: api.envelopes,
    initialData: demo ? demoEnvelopes : undefined,
    enabled: !demo,
    retry: 1,
  });
  const transactionsQuery = useQuery({
    queryKey: ["transactions", "today"],
    queryFn: () => api.transactions(""),
    initialData: demo ? demoTransactions : undefined,
    enabled: !demo,
    retry: 1,
  });
  const billsQuery = useQuery({
    queryKey: ["bills"],
    queryFn: api.bills,
    initialData: demo ? demoBills : undefined,
    enabled: !demo,
    retry: 1,
  });
  const goalsQuery = useQuery({
    queryKey: ["goals"],
    queryFn: api.goals,
    initialData: demo ? demoGoals : undefined,
    enabled: !demo,
    retry: 1,
  });
  const sessionQuery = useQuery({
    queryKey: ["session"],
    queryFn: api.session,
    initialData: demo
      ? { user: { id: "demo", email: "alex@example.com", name: "Alex" }, householdId: "demo" }
      : undefined,
    enabled: !demo,
    retry: false,
    staleTime: 60_000,
  });
  const [wealthRange, setWealthRange] = useState("1Y");
  const netWorthQuery = useQuery({
    queryKey: ["net-worth", wealthRange],
    queryFn: () => api.netWorthReport(wealthRange),
    initialData: demo ? demoNetWorth : undefined,
    enabled: !demo,
    retry: 1,
  });
  const activeGoal = useMemo(
    () =>
      [...(goalsQuery.data?.data ?? [])]
        .filter((goal) => !goal.paused && minor(goal.funded) < minor(goal.target))
        .sort((left, right) => left.priority - right.priority)[0],
    [goalsQuery.data],
  );
  const contributionsQuery = useQuery({
    queryKey: ["goal-contributions", activeGoal?.id],
    queryFn: () => {
      if (!activeGoal) throw new Error("An active goal is required");
      return api.goalContributions(activeGoal.id);
    },
    initialData: demo ? { data: [], page: { cursor: null, hasMore: false } } : undefined,
    enabled: !demo && Boolean(activeGoal),
    retry: 1,
  });
  const contribution = useMutation({
    mutationFn: ({ goal, amountMinorUnits }: { goal: ApiGoal; amountMinorUnits: string }) =>
      api.contributeToGoal(goal.id, {
        amount: { minorUnits: amountMinorUnits, currency: goal.target.currency },
        source: "today_goal_reserve",
        contributedOn: localIsoDate(new Date()),
        note: "Weekly earmark recorded from Today",
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["goals"] }),
        queryClient.invalidateQueries({ queryKey: ["goal-contributions"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
    },
  });

  if (dashboard.isPending)
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Today"
          title="Loading your plan"
          description="Reconciling balances, bills, envelopes, and goals."
        />
        <LoadingCard rows={5} />
        <LoadingCard rows={3} />
      </Stack>
    );
  if (!dashboard.data)
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Today"
          title="Your plan is temporarily unavailable"
          description="No estimate is safer than an invented one."
        />
        <ErrorState
          message="BetterWealth could not load a trusted dashboard report."
          onRetry={() => dashboard.refetch()}
        />
      </Stack>
    );
  const report = dashboard.data;
  const stale = dashboard.isError || report.trust.state === "stale";
  const runway = daysThrough(report.coveredThrough);
  const target = minor(report.targetLiquidNetWorth);
  const projected = minor(report.projectedLiquidNetWorth);
  const targetProgress =
    BigInt(report.targetLiquidNetWorth.minorUnits) > 0n
      ? Number(
          (BigInt(report.projectedLiquidNetWorth.minorUnits) * 100n) /
            BigInt(report.targetLiquidNetWorth.minorUnits),
        )
      : null;
  const firstName = sessionQuery.data?.user.name?.trim().split(/\s+/)[0] || "there";
  const planningWindowLabel =
    report.coveredThroughSource === "income_source" ? "Covered through" : "Planning window through";
  const projectionLabel =
    report.projectionSource === "forecast"
      ? "model forecast"
      : report.projectionSource === "cash_flow_run_rate"
        ? "90-day cash-flow run rate"
        : "current liquid balance";

  return (
    <Stack gap={{ xs: 5, sm: 6 }}>
      <PageHeader
        eyebrow={formatDate(new Date().toISOString(), {
          weekday: "long",
          month: "long",
          day: "numeric",
        })}
        title={`${greeting()}, ${firstName}`}
        description={
          report.trust.state === "ready"
            ? "Your balances and commitments are reconciled. Here is the next useful move."
            : "Your planning gaps are explicit below. Treat safe to spend as provisional until setup is complete."
        }
        actions={
          <Button
            component={RouterLink}
            to="/settings?section=appearance"
            variant="outlined"
            color="inherit"
            startIcon={<DragIndicatorRounded />}
          >
            Appearance
          </Button>
        }
      />
      {stale ? (
        <Alert severity="warning">
          This dashboard is using the latest stored snapshot. Refresh account data before making a
          large spending decision.
        </Alert>
      ) : null}
      <SafeToSpendHero
        report={report}
        goal={activeGoal}
        contributions={contributionsQuery.data?.data ?? []}
        actionLoading={
          goalsQuery.isPending || (Boolean(activeGoal) && contributionsQuery.isPending)
        }
        actionError={goalsQuery.isError || contributionsQuery.isError}
        readOnly={demo}
        onContribute={(goal, amountMinorUnits) =>
          contribution.mutateAsync({ goal, amountMinorUnits }).then(() => undefined)
        }
        contributionPending={contribution.isPending}
        contributionError={
          contribution.error instanceof Error ? contribution.error.message : undefined
        }
      />
      <Box
        sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(3, 1fr)" }, gap: 3 }}
      >
        <SignalCard
          icon={<ScheduleRounded />}
          title="Pay-cycle runway"
          value={`${runway} ${runway === 1 ? "day" : "days"}`}
          detail={`${planningWindowLabel} ${formatDate(report.coveredThrough, { month: "short", day: "numeric" })}`}
          tone="#4A7FD1"
        />
        <SignalCard
          icon={<CheckCircleRounded />}
          title="Plan status"
          value={
            report.trust.state === "ready"
              ? "Ready"
              : `${report.trust.missingInputs.length} input${report.trust.missingInputs.length === 1 ? "" : "s"} needed`
          }
          detail={report.trust.missingInputs[0] ?? report.trust.confidenceLabel}
          tone="#1F9D72"
        />
        <SignalCard
          icon={<TrendingUpRounded />}
          title={report.targetAge ? `Age-${report.targetAge} trajectory` : "Wealth trajectory"}
          value={
            <Money value={projected} currency={report.projectedLiquidNetWorth.currency} compact />
          }
          detail={
            target > 0 && targetProgress !== null
              ? `${Math.max(0, targetProgress)}% of your target · ${projectionLabel}`
              : `Add a target to compare progress · ${projectionLabel}`
          }
          tone="#8B6CCF"
        />
      </Box>
      <TrustStatePanel
        state={stale ? "stale" : report.trust.state}
        asOf={new Date(report.trust.asOf).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
        pendingImpact={minor(report.trust.pendingImpact)}
        missingInputs={
          stale && !report.trust.missingInputs.length
            ? ["fresh account balances"]
            : report.trust.missingInputs
        }
        onCorrect={() => {
          if (stale) {
            void dashboard.refetch();
            return;
          }
          const gap = report.trust.missingInputs[0]?.toLowerCase() ?? "";
          if (gap.includes("envelope")) navigate("/budget?action=add-envelope");
          else if (gap.includes("account")) navigate("/accounts?action=add");
          else navigate("/onboarding");
        }}
      />
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", xl: "1.08fr .92fr" },
          gap: 4,
          alignItems: "start",
        }}
      >
        <Box>
          <WealthChart query={netWorthQuery} range={wealthRange} onRangeChange={setWealthRange} />
        </Box>
        <EnvelopeGrid query={envelopesQuery} />
      </Box>
      <ActivityAndBills
        transactionsQuery={transactionsQuery}
        billsQuery={billsQuery}
        report={report}
      />
    </Stack>
  );
}
