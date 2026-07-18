import {
  AddRounded,
  AutoAwesomeRounded,
  CheckCircleRounded,
  ExpandMoreRounded,
  InfoOutlined,
  LockClockRounded,
  PlayArrowRounded,
  ScienceRounded,
  TuneRounded,
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
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  InputAdornment,
  Slider,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
} from "@mui/material";
import { LineChart } from "@mui/x-charts/LineChart";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  type ApiForecast,
  type ApiForecastRangePoint,
  type Money as ApiMoney,
  type ApiScenario,
  api,
  type CursorPage,
} from "../api";
import { Stack, TextField, Typography } from "../components/mui";
import {
  ChartMaskedState,
  EmptyState,
  ErrorState,
  formatMoney,
  LoadingCard,
  MetricCard,
  Money,
  PageHeader,
  SectionHeader,
  StatusChip,
} from "../components/ui";
import { usePrivacy } from "../contexts";
import { forecastHistory } from "../data";
import { isDemoMode } from "../demo";
import { chartTickFormatter, minorToMajor } from "../lib/money";

function forecastMoney(value: number): ApiMoney {
  return { minorUnits: String(Math.round(value * 100)), currency: "USD" };
}

function minor(money: ApiMoney | undefined): number {
  return money ? minorToMajor(money.minorUnits, money.currency) : 0;
}

function displayMonth(month: string, includeYear = true): string {
  const parsed = new Date(`${month.slice(0, 7)}-01T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return month;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    ...(includeYear ? { year: "2-digit" } : {}),
  });
}

function sampledRows<T>(rows: T[], maximum = 5): T[] {
  if (rows.length <= maximum) return rows;
  const indices = Array.from(
    new Set(
      Array.from({ length: maximum }, (_, index) =>
        Math.round((index * (rows.length - 1)) / (maximum - 1)),
      ),
    ),
  );
  const result: T[] = [];
  for (const index of indices) {
    const row = rows[index];
    if (row !== undefined) result.push(row);
  }
  return result;
}

const demoScenario: ApiScenario = {
  id: "scenario_demo_baseline",
  name: "Baseline",
  preset: "baseline",
  assumptions: {
    incomeGrowth: 3.2,
    inflation: 2.6,
    investmentReturn: 6.5,
    cashYield: 4.1,
    monthlyInvesting: forecastMoney(700),
  },
  seed: 300122,
  isBase: true,
};

const demoScenarios: CursorPage<ApiScenario> = {
  data: [
    {
      ...demoScenario,
      id: "scenario_demo_conservative",
      name: "Conservative",
      preset: "conservative",
      assumptions: { ...demoScenario.assumptions, investmentReturn: 4 },
      seed: 300121,
      isBase: false,
    },
    demoScenario,
    {
      ...demoScenario,
      id: "scenario_demo_ambitious",
      name: "Ambitious",
      preset: "ambitious",
      assumptions: {
        ...demoScenario.assumptions,
        incomeGrowth: 5,
        investmentReturn: 8.5,
        monthlyInvesting: forecastMoney(1000),
      },
      seed: 300123,
      isBase: false,
    },
  ],
  page: { cursor: null, hasMore: false },
};

function demoForecastFor(scenario: ApiScenario): ApiForecast {
  const key =
    scenario.preset === "conservative"
      ? "conservative"
      : scenario.preset === "ambitious"
        ? "ambitious"
        : "baseline";
  const defaults =
    key === "conservative"
      ? { incomeGrowth: 3.2, inflation: 2.6, investmentReturn: 4, cashYield: 4.1, monthly: 700 }
      : key === "ambitious"
        ? {
            incomeGrowth: 5,
            inflation: 2.6,
            investmentReturn: 8.5,
            cashYield: 4.1,
            monthly: 1000,
          }
        : {
            incomeGrowth: 3.2,
            inflation: 2.6,
            investmentReturn: 6.5,
            cashYield: 4.1,
            monthly: 700,
          };
  const monthly = minor(scenario.assumptions.monthlyInvesting);
  const trajectory = forecastHistory.map((row, index) => {
    const value = Math.max(
      0,
      row[key] +
        (monthly - defaults.monthly) * 12 * index * (1 + index * 0.025) +
        (scenario.assumptions.investmentReturn - defaults.investmentReturn) *
          row[key] *
          index *
          0.004 +
        (scenario.assumptions.incomeGrowth - defaults.incomeGrowth) * 180 * index ** 2 -
        (scenario.assumptions.inflation - defaults.inflation) * 110 * index ** 2 +
        (scenario.assumptions.cashYield - defaults.cashYield) * 35 * index ** 2,
    );
    return {
      month: `${2026 + index}-07`,
      liquidCash: forecastMoney(value),
      netWorth: forecastMoney(value),
    };
  });
  const ranges: ApiForecastRangePoint[] = trajectory.map((point, index) => {
    const value = minor(point.netWorth);
    const wideSpread = Math.min(0.32, index * 0.04);
    const narrowSpread = wideSpread / 2;
    const range = {
      p10: forecastMoney(value * (1 - wideSpread)),
      p25: forecastMoney(value * (1 - narrowSpread)),
      p50: forecastMoney(value),
      p75: forecastMoney(value * (1 + narrowSpread)),
      p90: forecastMoney(value * (1 + wideSpread)),
    };
    return { month: point.month, netWorth: range, liquidCash: range };
  });
  const ending = trajectory.at(-1) ?? {
    month: "2034-07",
    liquidCash: forecastMoney(0),
    netWorth: forecastMoney(0),
  };
  const finalRange = ranges.at(-1)?.netWorth ?? {};
  return {
    id: `forecast_${scenario.id}`,
    scenarioId: scenario.id,
    engineVersion: "1.0.0",
    seed: scenario.seed,
    state: "succeeded",
    horizonDate: "2034-07-01",
    liquidNetWorthAtTarget: ending.liquidCash,
    totalNetWorthAtTarget: ending.netWorth,
    lowestCashBalance: forecastMoney(1084),
    debtFreeDate: "2028-10-01",
    percentiles: ([10, 25, 50, 75, 90] as const).map((percentile) => ({
      percentile,
      amount: finalRange[`p${percentile}`] ?? ending.netWorth,
    })),
    trajectory,
    monteCarlo: {
      runs: 1000,
      goalSuccessProbability: Math.max(0.1, Math.min(0.95, minor(ending.netWorth) / 250_000)),
      ranges,
    },
    readiness: {
      score: 92,
      missingInputs: ["Confirm the next credit-card statement"],
      confidenceLabel: "High",
    },
    createdAt: "2026-07-16T10:42:00.000Z",
  };
}

const demoForecasts: CursorPage<ApiForecast> = {
  data: demoScenarios.data.map(demoForecastFor),
  page: { cursor: null, hasMore: false },
};

function ForecastChart({
  forecast,
  scenarioName,
}: {
  forecast: ApiForecast | undefined;
  scenarioName: string;
}) {
  const { privacyEnabled } = usePrivacy();
  const rangeByMonth = useMemo(
    () => new Map(forecast?.monteCarlo?.ranges.map((point) => [point.month, point]) ?? []),
    [forecast],
  );
  const dataset = useMemo(
    () =>
      (forecast?.trajectory ?? []).map((point) => {
        const range = rangeByMonth.get(point.month)?.netWorth;
        return {
          month: displayMonth(point.month),
          deterministic: minor(point.netWorth),
          p10: range?.p10 ? minor(range.p10) : undefined,
          p50: range?.p50 ? minor(range.p50) : undefined,
          p90: range?.p90 ? minor(range.p90) : undefined,
        };
      }),
    [forecast, rangeByMonth],
  );
  const hasRanges = Boolean(forecast?.monteCarlo?.ranges.length);
  const tableRows = sampledRows(forecast?.monteCarlo?.ranges ?? []);
  const currency = forecast?.totalNetWorthAtTarget.currency ?? "USD";

  return (
    <Card>
      <CardContent sx={{ p: { xs: 4, sm: 5 } }}>
        <SectionHeader
          title="Projected net-worth path"
          description="The solid line is the exact result of the selected scenario. Seeded ranges appear only when they were calculated."
          action={
            <Chip
              icon={<ScienceRounded />}
              label={
                hasRanges
                  ? `${forecast?.monteCarlo?.runs.toLocaleString() ?? 0} seeded runs`
                  : "Deterministic run"
              }
              variant="outlined"
            />
          }
        />
        {!forecast || dataset.length === 0 ? (
          <Stack alignItems="center" textAlign="center" sx={{ py: 9, px: 3 }}>
            <Box
              sx={{
                width: 48,
                height: 48,
                borderRadius: 3,
                display: "grid",
                placeItems: "center",
                bgcolor: "action.hover",
                color: "text.secondary",
              }}
            >
              <ScienceRounded />
            </Box>
            <Typography variant="h3" sx={{ mt: 3 }}>
              No completed run for this scenario
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: 520 }}>
              Run the forecast to generate a versioned monthly trajectory from the assumptions shown
              here.
            </Typography>
          </Stack>
        ) : (
          <>
            <Box sx={{ mt: 4 }}>
              {privacyEnabled ? (
                <ChartMaskedState />
              ) : (
                <LineChart
                  height={360}
                  dataset={dataset}
                  xAxis={[{ dataKey: "month", scaleType: "point" }]}
                  yAxis={[
                    {
                      valueFormatter: chartTickFormatter(currency),
                      width: 58,
                    },
                  ]}
                  series={[
                    ...(hasRanges
                      ? [
                          {
                            dataKey: "p10",
                            label: "P10",
                            color: "#D98B2B",
                            showMark: false,
                            valueFormatter: (value: number | null) =>
                              formatMoney(Number(value ?? 0), currency),
                          },
                          {
                            dataKey: "p50",
                            label: "P50",
                            color: "#4A7FD1",
                            showMark: false,
                            valueFormatter: (value: number | null) =>
                              formatMoney(Number(value ?? 0), currency),
                          },
                          {
                            dataKey: "p90",
                            label: "P90",
                            color: "#7F6BB2",
                            showMark: false,
                            valueFormatter: (value: number | null) =>
                              formatMoney(Number(value ?? 0), currency),
                          },
                        ]
                      : []),
                    {
                      dataKey: "deterministic",
                      label: scenarioName,
                      color: "#1F9D72",
                      area: !hasRanges,
                      showMark: false,
                      valueFormatter: (value: number | null) =>
                        formatMoney(Number(value ?? 0), currency),
                    },
                  ]}
                  grid={{ horizontal: true }}
                  margin={{ left: 5, right: 18, top: 22, bottom: 10 }}
                />
              )}
            </Box>
            <Typography variant="body2" color="text.secondary">
              {privacyEnabled ? (
                "Chart values are hidden."
              ) : (
                <>
                  The {scenarioName} run ends in {displayMonth(forecast.horizonDate)} at{" "}
                  <strong>
                    <Money value={minor(forecast.totalNetWorthAtTarget)} compact />
                  </strong>{" "}
                  total net worth.
                </>
              )}
            </Typography>
            {hasRanges ? (
              <Accordion
                disableGutters
                elevation={0}
                sx={{ mt: 2, "&::before": { display: "none" } }}
              >
                <AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ px: 0 }}>
                  <Typography variant="body2" fontWeight={700}>
                    View sampled percentile table
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ px: 0, overflowX: "auto" }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Month</TableCell>
                        {["P10", "P25", "P50", "P75", "P90"].map((label) => (
                          <TableCell key={label} align="right">
                            {label}
                          </TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {tableRows.map((row) => (
                        <TableRow key={row.month}>
                          <TableCell>{displayMonth(row.month)}</TableCell>
                          {(["p10", "p25", "p50", "p75", "p90"] as const).map((key) => (
                            <TableCell key={key} align="right">
                              {row.netWorth[key] ? (
                                <Money value={minor(row.netWorth[key])} compact />
                              ) : (
                                "—"
                              )}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </AccordionDetails>
              </Accordion>
            ) : (
              <Alert severity="info" sx={{ mt: 3 }}>
                This run has no uncertainty range. Turn on Monte Carlo ranges and run it again to
                calculate P10–P90 outcomes.
              </Alert>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AssumptionSlider({
  label,
  value,
  setValue,
  min,
  max,
  step = 0.1,
  suffix = "%",
}: {
  label: string;
  value: number;
  setValue: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="body2" fontWeight={700}>
          {label}
        </Typography>
        <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {value}
          {suffix}
        </Typography>
      </Stack>
      <Slider
        value={value}
        onChange={(_, next) => setValue(next as number)}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        valueLabelDisplay="auto"
        valueLabelFormat={(next) => `${next}${suffix}`}
        sx={{ mt: 1 }}
      />
    </Box>
  );
}

export function ForecastPage() {
  const [selectedScenarioId, setSelectedScenarioId] = useState("");
  const [incomeGrowth, setIncomeGrowth] = useState(3);
  const [inflation, setInflation] = useState(2.5);
  const [returnRate, setReturnRate] = useState(6.5);
  const [cashYield, setCashYield] = useState(3);
  const [monthlyInvesting, setMonthlyInvesting] = useState(700);
  const [monteCarlo, setMonteCarlo] = useState(true);
  const [newScenarioOpen, setNewScenarioOpen] = useState(false);
  const [newScenarioName, setNewScenarioName] = useState("");
  const [demoScenarioData, setDemoScenarioData] = useState<ApiScenario[]>(demoScenarios.data);
  const [demoForecastData, setDemoForecastData] = useState<ApiForecast[]>(demoForecasts.data);
  const [demoMessage, setDemoMessage] = useState("");
  const demo = isDemoMode();
  const queryClient = useQueryClient();
  const scenariosQuery = useQuery({
    queryKey: ["scenarios"],
    queryFn: api.scenarios,
    initialData: demo ? demoScenarios : undefined,
    enabled: !demo,
    retry: 1,
  });
  const forecastsQuery = useQuery({
    queryKey: ["forecasts"],
    queryFn: api.forecasts,
    initialData: demo ? demoForecasts : undefined,
    enabled: !demo,
    retry: 1,
  });

  const scenarios = demo ? demoScenarioData : (scenariosQuery.data?.data ?? []);
  const selectedScenario =
    scenarios.find((item) => item.id === selectedScenarioId) ??
    scenarios.find((item) => item.isBase) ??
    scenarios[0];
  const completedForecasts = (demo ? demoForecastData : (forecastsQuery.data?.data ?? [])).filter(
    (item) => item.state === undefined || item.state === "succeeded",
  );
  const latestForecast = completedForecasts.find(
    (item) => item.scenarioId === selectedScenario?.id,
  );
  const baseScenario = scenarios.find((item) => item.isBase);
  const baseForecast = completedForecasts.find((item) => item.scenarioId === baseScenario?.id);

  useEffect(() => {
    if (!selectedScenario) return;
    if (selectedScenario.id !== selectedScenarioId) setSelectedScenarioId(selectedScenario.id);
  }, [selectedScenario, selectedScenarioId]);

  useEffect(() => {
    if (!selectedScenario) return;
    const assumptions = selectedScenario.assumptions;
    setIncomeGrowth(assumptions.incomeGrowth);
    setInflation(assumptions.inflation);
    setReturnRate(assumptions.investmentReturn);
    setCashYield(assumptions.cashYield);
    setMonthlyInvesting(minor(assumptions.monthlyInvesting));
  }, [selectedScenario]);

  const runForecast = useMutation({
    mutationFn: async () => {
      if (!selectedScenario) throw new Error("Create a scenario before running a forecast.");
      await api.updateScenario(selectedScenario.id, {
        assumptions: {
          incomeGrowth,
          inflation,
          investmentReturn: returnRate,
          cashYield,
          monthlyInvesting: forecastMoney(monthlyInvesting),
        },
      });
      return api.runForecast({
        scenarioId: selectedScenario.id,
        seed: selectedScenario.seed,
        monteCarloRuns: monteCarlo ? 1000 : 0,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["scenarios"] }),
        queryClient.invalidateQueries({ queryKey: ["forecasts"] }),
      ]);
    },
  });
  const createScenario = useMutation({
    mutationFn: () =>
      api.createScenario({
        name: newScenarioName,
        preset: "custom",
        assumptions: {
          incomeGrowth,
          inflation,
          investmentReturn: returnRate,
          cashYield,
          monthlyInvesting: forecastMoney(monthlyInvesting),
        },
        seed: Date.now() % 1_000_000_000,
        isBase: scenarios.length === 0,
      }),
    onSuccess: async (created) => {
      setNewScenarioOpen(false);
      setNewScenarioName("");
      setSelectedScenarioId(created.id);
      await queryClient.invalidateQueries({ queryKey: ["scenarios"] });
    },
  });

  const comparison = useMemo(() => {
    if (
      !latestForecast ||
      !baseForecast ||
      !baseScenario ||
      selectedScenario?.id === baseScenario.id
    )
      return undefined;
    if (
      latestForecast.horizonDate !== baseForecast.horizonDate ||
      latestForecast.totalNetWorthAtTarget.currency !== baseForecast.totalNetWorthAtTarget.currency
    )
      return undefined;
    return {
      name: baseScenario.name,
      delta:
        Number(
          BigInt(latestForecast.totalNetWorthAtTarget.minorUnits) -
            BigInt(baseForecast.totalNetWorthAtTarget.minorUnits),
        ) / 100,
    };
  }, [baseForecast, baseScenario, latestForecast, selectedScenario]);

  const closeNewScenario = () => {
    setNewScenarioOpen(false);
    setNewScenarioName("");
  };
  const runDemoForecast = () => {
    if (!selectedScenario) return;
    const updatedScenario: ApiScenario = {
      ...selectedScenario,
      assumptions: {
        incomeGrowth,
        inflation,
        investmentReturn: returnRate,
        cashYield,
        monthlyInvesting: forecastMoney(monthlyInvesting),
      },
    };
    setDemoScenarioData((current) =>
      current.map((item) => (item.id === updatedScenario.id ? updatedScenario : item)),
    );
    setDemoForecastData((current) => [
      demoForecastFor(updatedScenario),
      ...current.filter((item) => item.scenarioId !== updatedScenario.id),
    ]);
    setDemoMessage(`${updatedScenario.name} preview recalculated from the visible assumptions.`);
  };
  const createDemoScenario = () => {
    const name = newScenarioName.trim();
    if (!name) return;
    const now = Date.now();
    const created: ApiScenario = {
      id: `scenario_demo_custom_${now}`,
      name,
      preset: "custom",
      assumptions: {
        incomeGrowth,
        inflation,
        investmentReturn: returnRate,
        cashYield,
        monthlyInvesting: forecastMoney(monthlyInvesting),
      },
      seed: now % 1_000_000_000,
      isBase: false,
    };
    setDemoScenarioData((current) => [...current, created]);
    setSelectedScenarioId(created.id);
    setDemoMessage(`${created.name} was added to this interactive demo session.`);
    closeNewScenario();
  };
  const scenarioDialog = (
    <Dialog open={newScenarioOpen} onClose={closeNewScenario} fullWidth maxWidth="xs">
      <DialogTitle>New forecast scenario</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          label="Scenario name"
          value={newScenarioName}
          onChange={(event) => setNewScenarioName(event.target.value)}
          helperText="The current assumptions become the starting point."
          sx={{ mt: 1 }}
        />
      </DialogContent>
      {createScenario.error instanceof Error ? (
        <Alert severity="error" sx={{ mx: 3 }}>
          {createScenario.error.message}
        </Alert>
      ) : null}
      <DialogActions>
        <Button onClick={closeNewScenario}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!newScenarioName.trim() || createScenario.isPending}
          onClick={() => (demo ? createDemoScenario() : createScenario.mutate())}
        >
          {createScenario.isPending ? "Creating…" : "Create scenario"}
        </Button>
      </DialogActions>
    </Dialog>
  );

  if (scenariosQuery.isPending || forecastsQuery.isPending) {
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Forecast"
          title="Loading scenarios"
          description="Reading the latest versioned assumptions and results."
        />
        <LoadingCard rows={6} />
      </Stack>
    );
  }
  if (scenariosQuery.isError || forecastsQuery.isError) {
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Forecast"
          title="Forecast unavailable"
          description="No scenario has been changed."
        />
        <ErrorState
          message="BetterWealth could not load forecast scenarios and results."
          onRetry={() => {
            void scenariosQuery.refetch();
            void forecastsQuery.refetch();
          }}
        />
      </Stack>
    );
  }
  if (!selectedScenario) {
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Forecast"
          title="Create your first scenario"
          description="Start with explicit income, inflation, return, and contribution assumptions."
        />
        <EmptyState
          icon={<ScienceRounded />}
          title="No scenarios yet"
          description="A scenario is required before the deterministic projection can run."
          actionLabel="New scenario"
          onAction={() => setNewScenarioOpen(true)}
        />
        {scenarioDialog}
      </Stack>
    );
  }

  const readinessScore = latestForecast?.readiness.score;
  const readinessLabel = latestForecast?.readiness.confidenceLabel;
  const missingInputs = latestForecast?.readiness.missingInputs ?? [];
  const targetProbability = latestForecast?.monteCarlo?.goalSuccessProbability;

  return (
    <Stack gap={5}>
      <PageHeader
        eyebrow="Forecast"
        title="See where today’s plan can lead"
        description={
          demo
            ? "Change one assumption at a time and recalculate an interactive local preview."
            : "Change one assumption at a time. Every displayed result comes from a stored, reproducible forecast run."
        }
        actions={
          <>
            <Button
              variant="outlined"
              startIcon={<AddRounded />}
              onClick={() => setNewScenarioOpen(true)}
            >
              New scenario
            </Button>
            <Button
              variant="contained"
              startIcon={<PlayArrowRounded />}
              disabled={runForecast.isPending}
              onClick={() => (demo ? runDemoForecast() : runForecast.mutate())}
            >
              {demo ? "Run preview" : runForecast.isPending ? "Running…" : "Run forecast"}
            </Button>
          </>
        }
      />
      {runForecast.error instanceof Error ? (
        <Alert severity="error">{runForecast.error.message}</Alert>
      ) : null}
      {demo ? (
        <Alert severity={demoMessage ? "success" : "info"}>
          {demoMessage ||
            "Interactive preview: create scenarios and recalculate results locally. Sign in to store versioned runs."}
        </Alert>
      ) : null}
      <Card sx={{ p: 1 }}>
        <Tabs
          value={selectedScenario.id}
          onChange={(_, value: string) => setSelectedScenarioId(value)}
          variant="scrollable"
          scrollButtons="auto"
          aria-label="Forecast scenarios"
        >
          {scenarios.map((item) => (
            <Tab
              key={item.id}
              value={item.id}
              label={`${item.name}${item.isBase ? " · Base" : ""}`}
            />
          ))}
        </Tabs>
      </Card>
      {latestForecast ? (
        <Alert
          severity={
            (readinessScore ?? 0) >= 80
              ? "success"
              : (readinessScore ?? 0) >= 50
                ? "warning"
                : "info"
          }
          icon={(readinessScore ?? 0) >= 80 ? <CheckCircleRounded /> : <WarningAmberRounded />}
        >
          <strong>
            {readinessLabel} readiness ({readinessScore}/100).
          </strong>{" "}
          {missingInputs.length
            ? `${missingInputs.length} input${missingInputs.length === 1 ? "" : "s"} still limit confidence.`
            : "All engine-required inputs were present for this run."}
        </Alert>
      ) : (
        <Alert severity="info" icon={<InfoOutlined />}>
          This scenario has no completed result yet. Its assumptions are ready to review before the
          first run.
        </Alert>
      )}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr 1fr", lg: "repeat(4, 1fr)" },
          gap: 3,
        }}
      >
        <MetricCard
          label="Liquid cash at horizon"
          value={
            latestForecast ? (
              <Money value={minor(latestForecast.liquidNetWorthAtTarget)} compact />
            ) : (
              "Not run"
            )
          }
          helper={
            latestForecast ? `At ${displayMonth(latestForecast.horizonDate)}` : "Run this scenario"
          }
        />
        <MetricCard
          label="Total net worth at horizon"
          value={
            latestForecast ? (
              <Money value={minor(latestForecast.totalNetWorthAtTarget)} compact />
            ) : (
              "Not run"
            )
          }
          helper="Accounts less modeled debt"
        />
        <MetricCard
          label="Lowest cash balance"
          value={
            latestForecast ? <Money value={minor(latestForecast.lowestCashBalance)} /> : "Not run"
          }
          helper="Lowest primary-cash point"
        />
        <MetricCard
          label="Debt-free"
          value={
            latestForecast?.debtFreeDate
              ? new Date(
                  `${latestForecast.debtFreeDate.slice(0, 7)}-01T12:00:00`,
                ).toLocaleDateString("en-US", { month: "short", year: "numeric" })
              : "Not projected"
          }
          helper="Within the selected horizon"
        />
      </Box>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", xl: "minmax(0, 1.35fr) minmax(310px, .65fr)" },
          gap: 4,
          alignItems: "start",
        }}
      >
        <ForecastChart forecast={latestForecast} scenarioName={selectedScenario.name} />
        <Card>
          <CardContent sx={{ p: 5 }}>
            <SectionHeader
              title="Assumptions"
              description={`${demo ? "Previewed" : "Stored"} with ${selectedScenario.name}.`}
              action={<TuneRounded color="action" />}
            />
            <Stack gap={4} sx={{ mt: 5 }}>
              <AssumptionSlider
                label="Income growth"
                value={incomeGrowth}
                setValue={setIncomeGrowth}
                min={-5}
                max={12}
              />
              <AssumptionSlider
                label="Inflation"
                value={inflation}
                setValue={setInflation}
                min={-2}
                max={12}
              />
              <AssumptionSlider
                label="Investment return"
                value={returnRate}
                setValue={setReturnRate}
                min={-10}
                max={20}
              />
              <AssumptionSlider
                label="Cash yield"
                value={cashYield}
                setValue={setCashYield}
                min={0}
                max={10}
              />
              <TextField
                label="Monthly investing"
                type="number"
                value={monthlyInvesting}
                onChange={(event) => setMonthlyInvesting(Number(event.target.value))}
                InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
                inputProps={{ min: 0, step: 25 }}
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={monteCarlo}
                    onChange={(event) => setMonteCarlo(event.target.checked)}
                  />
                }
                label={
                  <Box>
                    <Typography variant="body2" fontWeight={700}>
                      Monte Carlo ranges
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Seed {selectedScenario.seed} ·{" "}
                      {monteCarlo ? "1,000 runs" : "deterministic only"}
                    </Typography>
                  </Box>
                }
              />
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 5 }}>
              Latest engine: {latestForecast?.engineVersion ?? "not run"}
            </Typography>
          </CardContent>
        </Card>
      </Box>
      <Card
        sx={{
          background: (theme) =>
            `linear-gradient(130deg, ${alpha(theme.palette.info.main, 0.1)}, ${alpha(theme.palette.secondary.main, 0.08)})`,
        }}
      >
        <CardContent sx={{ p: { xs: 5, sm: 6 } }}>
          <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={4}>
            <Stack direction="row" gap={3} alignItems="flex-start">
              <Box
                sx={{
                  width: 44,
                  height: 44,
                  borderRadius: 3,
                  display: "grid",
                  placeItems: "center",
                  bgcolor: "background.paper",
                  color: "info.main",
                  flexShrink: 0,
                }}
              >
                <AutoAwesomeRounded />
              </Box>
              <Box>
                <Typography variant="h3">Scenario difference, translated</Typography>
                {comparison ? (
                  <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 760 }}>
                    Compared with {comparison.name} at the same horizon, {selectedScenario.name}{" "}
                    ends{" "}
                    <strong>
                      <Money value={Math.abs(comparison.delta)} compact />
                    </strong>{" "}
                    {comparison.delta >= 0 ? "higher" : "lower"} in total net worth. The selected
                    plan invests{" "}
                    <strong>
                      <Money value={monthlyInvesting} />
                    </strong>{" "}
                    per month.
                  </Typography>
                ) : latestForecast && selectedScenario.isBase ? (
                  <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 760 }}>
                    {selectedScenario.name} is the comparison anchor. Select another scenario with a
                    completed run to see its exact dollar difference here.
                  </Typography>
                ) : (
                  <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 760 }}>
                    A matching completed baseline run is not available, so BetterWealth will not
                    invent a comparison. Run the baseline at the same horizon to unlock it.
                  </Typography>
                )}
              </Box>
            </Stack>
            {baseScenario && selectedScenario.id !== baseScenario.id ? (
              <Button variant="outlined" onClick={() => setSelectedScenarioId(baseScenario.id)}>
                View baseline
              </Button>
            ) : null}
          </Stack>
        </CardContent>
      </Card>
      <Box
        sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "repeat(2, 1fr)" }, gap: 4 }}
      >
        <Card>
          <CardContent sx={{ p: 5 }}>
            <SectionHeader
              title="Target outcome"
              description="A probability appears only when this scenario has an explicit Monte Carlo success target."
            />
            {typeof targetProbability === "number" ? (
              <Stack alignItems="flex-start" gap={2} sx={{ mt: 5 }}>
                <Typography sx={{ fontSize: 42, fontWeight: 760, letterSpacing: "-0.04em" }}>
                  {Math.round(targetProbability * 100)}%
                </Typography>
                <StatusChip
                  label={`${latestForecast?.monteCarlo?.runs.toLocaleString() ?? 0} seeded runs`}
                  tone="info"
                />
                <Typography variant="body2" color="text.secondary">
                  Share of runs that reached the target stored with this scenario.
                </Typography>
              </Stack>
            ) : (
              <Stack alignItems="center" textAlign="center" sx={{ py: 7, px: 3 }}>
                <Box
                  sx={{
                    width: 48,
                    height: 48,
                    borderRadius: 3,
                    display: "grid",
                    placeItems: "center",
                    bgcolor: "action.hover",
                    color: "text.secondary",
                  }}
                >
                  <LockClockRounded />
                </Box>
                <Typography variant="h3" sx={{ mt: 3 }}>
                  No probability target configured
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: 520 }}>
                  The deterministic result is available, but this scenario does not define a success
                  amount and month. No goal odds are inferred.
                </Typography>
              </Stack>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent sx={{ p: 5 }}>
            <SectionHeader
              title="Readiness gate"
              description="Missing data widens uncertainty instead of creating false precision."
            />
            {!latestForecast ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 5 }}>
                Readiness is calculated as part of the first run.
              </Typography>
            ) : (
              <Stack gap={3} sx={{ mt: 5 }}>
                <Stack direction="row" alignItems="center" gap={2}>
                  {(readinessScore ?? 0) >= 80 ? (
                    <CheckCircleRounded sx={{ color: "success.main", fontSize: 19 }} />
                  ) : (
                    <WarningAmberRounded sx={{ color: "warning.main", fontSize: 19 }} />
                  )}
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    Engine readiness
                  </Typography>
                  <StatusChip
                    label={`${readinessScore}/100 · ${readinessLabel}`}
                    tone={(readinessScore ?? 0) >= 80 ? "positive" : "warning"}
                  />
                </Stack>
                {missingInputs.length ? (
                  missingInputs.map((label) => (
                    <Stack key={label} direction="row" alignItems="center" gap={2}>
                      <WarningAmberRounded sx={{ color: "warning.main", fontSize: 19 }} />
                      <Typography variant="body2" sx={{ flex: 1 }}>
                        {label}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Missing
                      </Typography>
                    </Stack>
                  ))
                ) : (
                  <Stack direction="row" alignItems="center" gap={2}>
                    <CheckCircleRounded sx={{ color: "success.main", fontSize: 19 }} />
                    <Typography variant="body2">All required forecast inputs present</Typography>
                  </Stack>
                )}
              </Stack>
            )}
            <Button
              component={RouterLink}
              to="/accounts"
              fullWidth
              variant="outlined"
              sx={{ mt: 5 }}
            >
              Review account inputs
            </Button>
          </CardContent>
        </Card>
      </Box>
      <Alert severity="info" icon={<InfoOutlined />}>
        Forecasts are educational planning estimates, not promises or individualized investment
        advice. Actual returns, income, inflation, and spending will vary.
      </Alert>
      {scenarioDialog}
    </Stack>
  );
}
