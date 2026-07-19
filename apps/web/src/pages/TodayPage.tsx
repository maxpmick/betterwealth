import {
  ArrowForwardRounded,
  AutoAwesomeRounded,
  CalendarMonthRounded,
  CheckCircleRounded,
  DragIndicatorRounded,
  ExpandMoreRounded,
  FlagRounded,
  ReceiptLongRounded,
  ShieldRounded,
  TrendingUpRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
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
  useTheme,
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
import { PlanFlowCard } from "../components/PlanFlowCard";
import {
  ChartMaskedState,
  EmptyState,
  ErrorState,
  formatMoney,
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
import { isDemoMode } from "../demo";
import {
  demoBills,
  demoBudgets,
  demoDashboard,
  demoEnvelopes,
  demoGoals,
  demoNetWorth,
  demoSession,
  demoRecentTransactions as demoTransactions,
} from "../demoApi";
import { chartTickFormatter, minorToMajor } from "../lib/money";

function minor(money: { minorUnits: string; currency: string }) {
  return minorToMajor(money.minorUnits, money.currency);
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
  const suggested = minorToMajor(action.suggestedMinorUnits, report.safeToSpend.currency);
  const remaining = minorToMajor(action.remainingMinorUnits, report.safeToSpend.currency);
  const recorded = minorToMajor(action.recordedMinorUnits, report.safeToSpend.currency);
  const hasAction = Boolean(goal && BigInt(action.suggestedMinorUnits) > 0n && !actionError);
  const rawSafeToSpend =
    BigInt(report.availableCash.minorUnits) -
    BigInt(report.reservedBills.minorUnits) -
    BigInt(report.envelopeCommitments.minorUnits) -
    BigInt(report.goalContributions.minorUnits) -
    BigInt(report.minimumBuffer.minorUnits);
  return (
    <Card>
      <CardContent sx={{ p: { xs: 5, sm: 7 }, "&:last-child": { pb: { xs: 5, sm: 7 } } }}>
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={3}>
          <Box>
            <Stack direction="row" alignItems="center" gap={1.5}>
              <Typography variant="body2" color="text.secondary">
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
            <Typography variant="h3" sx={{ mt: 2 }}>
              <Money value={minor(report.safeToSpend)} currency={report.safeToSpend.currency} />
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
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
        <Accordion sx={{ mt: 6 }}>
          <AccordionSummary
            expandIcon={<ExpandMoreRounded />}
            aria-controls="safe-formula-content"
            id="safe-formula-header"
          >
            <Stack direction="row" gap={2} alignItems="center">
              <ShieldRounded fontSize="small" />
              <Typography variant="body2">Show how this is calculated</Typography>
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
                  <Typography variant="caption" color="text.secondary">
                    {operator} {label}
                  </Typography>
                  <Typography sx={{ mt: 0.5 }}>
                    <Money value={Number(value)} currency={report.safeToSpend.currency} />
                  </Typography>
                </Box>
              ))}
            </Box>
            <Divider sx={{ my: 3 }} />
            <Typography variant="body2" color="text.secondary">
              {rawSafeToSpend < 0n ? (
                <>
                  The raw formula is{" "}
                  <Money
                    value={minorToMajor(rawSafeToSpend, report.safeToSpend.currency)}
                    currency={report.safeToSpend.currency}
                  />
                  . Safe to spend is floored at{" "}
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
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 1,
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
                  borderRadius: 1,
                  display: "grid",
                  placeItems: "center",
                  flex: "0 0 auto",
                  bgcolor: "action.hover",
                  color: "text.secondary",
                }}
              >
                {hasAction ? (
                  <AutoAwesomeRounded fontSize="small" />
                ) : (
                  <ShieldRounded fontSize="small" />
                )}
              </Box>
              <Box>
                <Typography variant="subtitle2">
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
                    "Set a goal to start weekly earmarks"
                  )}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block", mt: 0.75 }}
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
                variant="outlined"
                endIcon={<ArrowForwardRounded />}
                onClick={() => setImpactOpen(true)}
                sx={{ whiteSpace: "nowrap" }}
              >
                Preview impact
              </Button>
            ) : !goal && !actionError ? (
              <Button
                component={RouterLink}
                to="/goals?action=add"
                variant="outlined"
                endIcon={<ArrowForwardRounded />}
                sx={{ whiteSpace: "nowrap" }}
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
            <Box sx={{ p: 4, bgcolor: "action.hover", borderRadius: 1 }}>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2">Contribution</Typography>
                <Typography variant="body2">
                  <Money value={suggested} currency={report.safeToSpend.currency} />
                </Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between" sx={{ mt: 2 }}>
                <Typography variant="body2">Already recorded this week</Typography>
                <Typography variant="body2">
                  <Money value={recorded} currency={report.safeToSpend.currency} />
                </Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between" sx={{ mt: 2 }}>
                <Typography variant="body2">Goal remaining afterward</Typography>
                <Typography variant="body2">
                  <Money
                    value={Math.max(0, remaining - suggested)}
                    currency={report.safeToSpend.currency}
                  />
                </Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between" sx={{ mt: 2 }}>
                <Typography variant="body2">Safe-to-spend afterward</Typography>
                <Typography variant="body2">
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
  const theme = useTheme();
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
          title="Net worth"
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
                      valueFormatter: chartTickFormatter(currency),
                      width: 48,
                    },
                  ]}
                  series={[
                    {
                      dataKey: "total",
                      label: "Total net worth",
                      color: theme.palette.primary.main,
                      area: true,
                      showMark: false,
                      valueFormatter: (value) => formatMoney(Number(value ?? 0), currency),
                    },
                    {
                      dataKey: "liquid",
                      label: "Liquid net worth",
                      color: theme.palette.success.main,
                      showMark: false,
                      valueFormatter: (value) => formatMoney(Number(value ?? 0), currency),
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
                : history.length === 1
                  ? `Current synced baseline: ${new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(history[0]?.total ?? 0)} total and ${new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(history[0]?.liquid ?? 0)} liquid.`
                  : `Total net worth moved from ${new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(history[0]?.total ?? 0)} to ${new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(history.at(-1)?.total ?? 0)}.`}
            </Typography>
            <Accordion
              disableGutters
              elevation={0}
              sx={{ mt: 2, border: 0, "&::before": { display: "none" } }}
            >
              <AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ px: 0 }}>
                <Typography variant="body2">View chart data table</Typography>
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
  return (
    <Card>
      <CardContent sx={{ p: { xs: 4, sm: 5 } }}>
        <SectionHeader
          title="Envelope pace"
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
                  ? "error"
                  : envelope.pacing === "watch"
                    ? "warning"
                    : "success";
              return (
                <Box
                  key={envelope.id}
                  sx={{ p: 3.5, border: "1px solid", borderColor: "divider", borderRadius: 1 }}
                >
                  <Stack direction="row" justifyContent="space-between" gap={2}>
                    <Typography variant="subtitle2">{envelope.name}</Typography>
                    <Typography variant="body2">
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
  const recent =
    transactionsQuery.data?.data
      .filter((transaction) => transaction.status !== "removed")
      .slice(0, 5) ?? [];
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
                      borderRadius: 1,
                      display: "grid",
                      placeItems: "center",
                      flex: "0 0 auto",
                      bgcolor: "action.hover",
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
                    <Typography variant="subtitle2" noWrap>
                      {item.merchant || item.description}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {item.categoryName} · {item.accountName}
                    </Typography>
                  </Box>
                  <Box sx={{ textAlign: "right" }}>
                    <Typography variant="body2">
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
              title="No transactions yet"
              description="Connect SimpleFIN or add a manual transaction to get started."
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
                      borderRadius: 1,
                      display: "grid",
                      placeItems: "center",
                      bgcolor: "action.hover",
                    }}
                  >
                    <CalendarMonthRounded fontSize="small" sx={{ color: "text.secondary" }} />
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="subtitle2" noWrap>
                      {bill.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {formatDate(bill.nextDueDate ?? "", { month: "short", day: "numeric" })}
                      {bill.autopayAccountId ? " · autopay" : bill.isRequired ? " · required" : ""}
                    </Typography>
                  </Box>
                  <Typography variant="body2">
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
  const budgetsQuery = useQuery({
    queryKey: ["budgets", "pay_cycle"],
    queryFn: () => api.budgets("pay_cycle"),
    initialData: demo ? demoBudgets : undefined,
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
    initialData: demo ? demoSession : undefined,
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
        <PageHeader title="Today" />
        <LoadingCard rows={5} />
        <LoadingCard rows={3} />
      </Stack>
    );
  if (!dashboard.data)
    return (
      <Stack gap={4}>
        <PageHeader title="Today" />
        <ErrorState
          message="The dashboard report could not be loaded."
          onRetry={() => dashboard.refetch()}
        />
      </Stack>
    );
  const report = dashboard.data;
  const stale = dashboard.isError || report.trust.state === "stale";
  const runway = daysThrough(report.coveredThrough);
  const firstName = sessionQuery.data?.user.name?.trim().split(/\s+/)[0] || "there";
  const currentBudget = budgetsQuery.data?.data[0];
  const budgetEnvelopes = (currentBudget?.envelopes ?? []).filter(
    (envelope) => envelope.isActive !== false,
  );
  const budgetSurplus = currentBudget
    ? currentBudget.surplus
      ? BigInt(currentBudget.surplus.minorUnits)
      : BigInt(currentBudget.plannedIncome.minorUnits) -
        budgetEnvelopes.reduce((sum, envelope) => sum + BigInt(envelope.planned.minorUnits), 0n)
    : 0n;
  const latestTransactions =
    transactionsQuery.data?.data.filter((transaction) => transaction.status !== "removed") ?? [];
  const categorizedTransactions = latestTransactions.filter(
    (transaction) => transaction.categoryName.toLocaleLowerCase() !== "uncategorized",
  ).length;
  const reviewCount = latestTransactions.filter(
    (transaction) => transaction.reviewState === "needs_review",
  ).length;
  const today = new Date().toISOString().slice(0, 10);
  const upcomingBills = (billsQuery.data?.data ?? []).filter(
    (bill) =>
      bill.isActive &&
      bill.nextDueDate &&
      bill.nextDueDate >= today &&
      bill.nextDueDate <= report.coveredThrough.slice(0, 10),
  );
  const goalProjection = activeGoal?.projectedDate ?? activeGoal?.earliestSafeDate;
  const goalRemaining = activeGoal
    ? BigInt(activeGoal.remaining?.minorUnits ?? activeGoal.target.minorUnits) -
      (activeGoal.remaining ? 0n : BigInt(activeGoal.funded.minorUnits))
    : 0n;
  const setupGapCount = report.trust.missingInputs.length;

  return (
    <Stack gap={{ xs: 5, sm: 6 }}>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
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
      <PlanFlowCard
        testId="today-money-loop"
        title="Plan overview"
        steps={[
          {
            id: "paycheck",
            label: "Paycheck plan",
            value: currentBudget ? (
              <Money
                value={minor(currentBudget.plannedIncome)}
                currency={currentBudget.plannedIncome.currency}
              />
            ) : (
              "No plan yet"
            ),
            detail: currentBudget
              ? `${budgetEnvelopes.length} active envelope${budgetEnvelopes.length === 1 ? "" : "s"} · ${runway} day runway`
              : "No pay-cycle budget yet.",
            icon: <CalendarMonthRounded />,
            to: "/budget",
            status: currentBudget ? "Pay cycle mapped" : "Setup needed",
            statusTone: currentBudget ? "info" : "warning",
          },
          {
            id: "protect",
            label: "Protect first",
            value: (
              <Money value={minor(report.reservedBills)} currency={report.reservedBills.currency} />
            ),
            detail: `${upcomingBills.length} dated obligation${upcomingBills.length === 1 ? "" : "s"} due before ${formatDate(report.coveredThrough, { month: "short", day: "numeric" })}`,
            icon: <ShieldRounded />,
            to: "/budget",
            status:
              BigInt(report.reservedBills.minorUnits) > 0n ? "Bills reserved" : "Check due dates",
            statusTone: BigInt(report.reservedBills.minorUnits) > 0n ? "positive" : "neutral",
          },
          {
            id: "automate",
            label: "Automate",
            value: latestTransactions.length
              ? `${categorizedTransactions}/${latestTransactions.length}`
              : "No activity",
            detail: latestTransactions.length
              ? `Latest entries categorized · ${reviewCount} need${reviewCount === 1 ? "s" : ""} review`
              : "Import transactions to enable automatic categorization.",
            icon: <AutoAwesomeRounded />,
            to: reviewCount ? "/automation?tab=ai" : "/automation",
            status: reviewCount ? `${reviewCount} to resolve` : "Ledger clean",
            statusTone: reviewCount ? "warning" : "positive",
          },
          {
            id: "grow",
            label: "Goals",
            value: activeGoal ? (
              goalProjection ? (
                formatDate(goalProjection, { month: "short", year: "numeric" })
              ) : (
                <Money
                  value={minorToMajor(goalRemaining, activeGoal.target.currency)}
                  currency={activeGoal.target.currency}
                />
              )
            ) : (
              "Add a goal"
            ),
            detail: activeGoal
              ? `${activeGoal.name}${typeof activeGoal.probability === "number" ? ` · ${Math.round(activeGoal.probability * 100)}% modeled likelihood` : ""}`
              : "Add a goal to project its funding date.",
            icon: <TrendingUpRounded />,
            to: "/goals",
            status: activeGoal
              ? activeGoal.onTrack === false
                ? "Behind pace"
                : "On track"
              : "No goal",
            statusTone: activeGoal
              ? activeGoal.onTrack === false
                ? "warning"
                : "info"
              : "neutral",
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
              {setupGapCount
                ? `Setup gap: ${report.trust.missingInputs[0]}`
                : "All setup steps are complete."}
            </Typography>
            <StatusChip
              label={
                currentBudget ? (
                  <>
                    {budgetSurplus >= 0n ? "Plan surplus " : "Plan gap "}
                    <Money
                      value={minorToMajor(
                        budgetSurplus < 0n ? -budgetSurplus : budgetSurplus,
                        currentBudget.plannedIncome.currency,
                      )}
                      currency={currentBudget.plannedIncome.currency}
                      compact
                    />
                  </>
                ) : (
                  `${setupGapCount} setup gap${setupGapCount === 1 ? "" : "s"}`
                )
              }
              tone={currentBudget ? (budgetSurplus >= 0n ? "positive" : "risk") : "warning"}
            />
          </Stack>
        }
      />
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
