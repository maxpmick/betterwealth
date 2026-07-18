import {
  AccountBalanceRounded,
  ArrowBackRounded,
  ArrowForwardRounded,
  CheckCircleRounded,
  CloudSyncRounded,
  EditRounded,
  InsightsRounded,
  LockRounded,
  RefreshRounded,
  ScienceRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import {
  Alert,
  alpha,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Divider,
  FormControl,
  InputAdornment,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Skeleton,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type DashboardReport, type Money } from "../api";
import { Stack, TextField, Typography } from "../components/mui";
import { formatMoneyExact } from "../lib/money";

const steps = ["Start", "Your target", "Cash flow", "Ready"];
type SourceChoice = "simplefin" | "manual" | "demo";

interface TargetForm {
  birthDate: string;
  targetAge: string;
  targetLiquidNetWorth: string;
  currency: string;
}

interface CashFlowForm {
  netPay: string;
  cadence: string;
  nextPayday: string;
  billsBeforePayday: string;
  minimumBuffer: string;
}

interface ManualAccountForm {
  name: string;
  openingBalance: string;
}

const demoDashboard: DashboardReport = {
  safeToSpend: { minorUnits: "61200", currency: "USD" },
  safePerDay: { minorUnits: "4371", currency: "USD" },
  coveredThrough: "2026-07-30",
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
    confidenceLabel: "Demo fixture",
  },
};

function isoDateOffset(days: number) {
  const value = new Date();
  value.setDate(value.getDate() + days);
  return value.toISOString().slice(0, 10);
}

function defaultBirthDate() {
  const value = new Date();
  value.setFullYear(value.getFullYear() - 22);
  return value.toISOString().slice(0, 10);
}

function moneyMinorUnits(value: string): string | null {
  const normalized = value.replace(/[$,\s]/g, "");
  if (!normalized) return null;
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) return null;
  const [whole = "0", decimal = ""] = normalized.split(".");
  return (BigInt(whole || "0") * 100n + BigInt(decimal.padEnd(2, "0") || "0")).toString();
}

function ageOnDate(birthDate: string, onDate = new Date()) {
  const birth = new Date(`${birthDate}T12:00:00`);
  if (Number.isNaN(birth.getTime()) || birth > onDate) return null;
  let age = onDate.getFullYear() - birth.getFullYear();
  const birthdayPassed =
    onDate.getMonth() > birth.getMonth() ||
    (onDate.getMonth() === birth.getMonth() && onDate.getDate() >= birth.getDate());
  if (!birthdayPassed) age -= 1;
  return age;
}

function formatMoney(value: Money) {
  return formatMoneyExact(value.minorUnits, value.currency);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value.length === 10 ? `${value}T12:00:00` : value));
}

function Brand() {
  return (
    <Stack direction="row" alignItems="center" gap={2}>
      <Box
        sx={{
          width: 32,
          height: 32,
          borderRadius: 2.5,
          color: "#fff",
          display: "grid",
          placeItems: "center",
          fontWeight: 800,
          background: "linear-gradient(140deg, #1F3A5F, #1F9D72)",
        }}
      >
        B
      </Box>
      <Typography fontWeight={760}>BetterWealth</Typography>
    </Stack>
  );
}

function ChoiceCard({
  icon,
  title,
  description,
  tag,
  selected,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  tag?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Card
      sx={{
        borderColor: selected ? "secondary.main" : "divider",
        boxShadow: selected
          ? (theme) => `0 0 0 3px ${alpha(theme.palette.secondary.main, 0.12)}`
          : undefined,
      }}
    >
      <CardActionArea
        onClick={onClick}
        sx={{ height: "100%", minHeight: 180, p: 1 }}
        aria-pressed={selected}
      >
        <CardContent>
          <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={2}>
            <Box
              sx={{
                width: 44,
                height: 44,
                borderRadius: 3,
                display: "grid",
                placeItems: "center",
                bgcolor: selected ? "secondary.main" : "action.hover",
                color: selected ? "#fff" : "text.secondary",
              }}
            >
              {icon}
            </Box>
            {tag ? (
              <Chip label={tag} size="small" color={selected ? "secondary" : "default"} />
            ) : null}
          </Stack>
          <Typography variant="h3" sx={{ mt: 4 }}>
            {title}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {description}
          </Typography>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

function StartStep({
  source,
  setSource,
  setupToken,
  setSetupToken,
  manual,
  setManual,
  claimError,
}: {
  source: SourceChoice;
  setSource: (source: SourceChoice) => void;
  setupToken: string;
  setSetupToken: (token: string) => void;
  manual: ManualAccountForm;
  setManual: (value: ManualAccountForm) => void;
  claimError: string | null;
}) {
  return (
    <Box>
      <Typography component="h1" variant="h1">
        How would you like to begin?
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 2 }}>
        Use your real data, enter one honest opening balance, or explore a clearly labeled demo.
      </Typography>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "repeat(3, 1fr)" },
          gap: 3,
          mt: 7,
        }}
      >
        <ChoiceCard
          icon={<CloudSyncRounded />}
          title="Connect SimpleFIN"
          description="Claim a one-time setup token and queue your first real account sync."
          tag="Recommended"
          selected={source === "simplefin"}
          onClick={() => setSource("simplefin")}
        />
        <ChoiceCard
          icon={<EditRounded />}
          title="Start manually"
          description="Create a cash account from an opening balance you enter—no invented transactions."
          selected={source === "manual"}
          onClick={() => setSource("manual")}
        />
        <ChoiceCard
          icon={<ScienceRounded />}
          title="Explore demo data"
          description="Open Alex’s fictional age-22 plan without changing your household data."
          selected={source === "demo"}
          onClick={() => setSource("demo")}
        />
      </Box>
      {source === "simplefin" ? (
        <Stack gap={3} sx={{ mt: 4 }}>
          <Alert severity="info" icon={<LockRounded />}>
            The API claims this token once, encrypts the resulting access URL, and returns only
            connection and sync status.
          </Alert>
          <TextField
            label="One-time SimpleFIN setup token"
            type="password"
            value={setupToken}
            onChange={(event) => setSetupToken(event.target.value)}
            fullWidth
            autoComplete="off"
            inputProps={{ spellCheck: false }}
            helperText="Hidden while you type. BetterWealth never returns this claim token from the API."
          />
          {claimError ? <Alert severity="error">{claimError}</Alert> : null}
        </Stack>
      ) : null}
      {source === "manual" ? (
        <Card sx={{ mt: 4 }}>
          <CardContent sx={{ p: 5 }}>
            <Stack direction="row" gap={2} alignItems="center">
              <AccountBalanceRounded color="secondary" />
              <Typography variant="h3">First cash account</Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              This creates one manual account after you confirm its reporting currency. You can add
              liabilities, investments, and transactions next.
            </Typography>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "1.2fr .8fr" },
                gap: 3,
                mt: 4,
              }}
            >
              <TextField
                label="Account name"
                value={manual.name}
                onChange={(event) => setManual({ ...manual, name: event.target.value })}
              />
              <TextField
                label="Opening balance"
                value={manual.openingBalance}
                onChange={(event) => setManual({ ...manual, openingBalance: event.target.value })}
                inputProps={{ inputMode: "decimal" }}
                InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
              />
            </Box>
          </CardContent>
        </Card>
      ) : null}
      {source === "demo" ? (
        <Alert severity="warning" sx={{ mt: 4 }}>
          Demo mode is fictional and browser-session only. It does not save profile, account, or
          planning data.
        </Alert>
      ) : null}
    </Box>
  );
}

function TargetStep({
  value,
  onChange,
  error,
}: {
  value: TargetForm;
  onChange: (value: TargetForm) => void;
  error: string | null;
}) {
  return (
    <Box>
      <Typography component="h1" variant="h1">
        Define your age-30 horizon
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 2 }}>
        These values are saved to your profile and drive the forecast horizon. They remain editable.
      </Typography>
      <Card sx={{ mt: 7 }}>
        <CardContent sx={{ p: { xs: 5, sm: 7 } }}>
          <Stack direction="row" gap={2} alignItems="center">
            <InsightsRounded color="secondary" />
            <Typography variant="h3">Profile and target</Typography>
          </Stack>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)" },
              gap: 4,
              mt: 5,
            }}
          >
            <TextField
              label="Date of birth"
              type="date"
              value={value.birthDate}
              onChange={(event) => onChange({ ...value, birthDate: event.target.value })}
              slotProps={{ inputLabel: { shrink: true } }}
              helperText="Used to calculate the exact horizon"
            />
            <TextField
              label="Target age"
              value={value.targetAge}
              onChange={(event) => onChange({ ...value, targetAge: event.target.value })}
              inputProps={{ inputMode: "numeric", min: 18, max: 120 }}
              helperText="Your explicit wealth checkpoint"
            />
            <TextField
              label="Liquid wealth target"
              value={value.targetLiquidNetWorth}
              onChange={(event) => onChange({ ...value, targetLiquidNetWorth: event.target.value })}
              inputProps={{ inputMode: "decimal" }}
              InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
              helperText="A suggested starting checkpoint—edit it to make it yours"
            />
            <FormControl size="small">
              <InputLabel id="currency-label">Reporting currency</InputLabel>
              <Select
                labelId="currency-label"
                value={value.currency}
                onChange={(event) => onChange({ ...value, currency: event.target.value })}
                label="Reporting currency"
              >
                <MenuItem value="USD">USD — US dollar</MenuItem>
                <MenuItem value="CAD">CAD — Canadian dollar</MenuItem>
                <MenuItem value="EUR">EUR — Euro</MenuItem>
                <MenuItem value="GBP">GBP — British pound</MenuItem>
              </Select>
            </FormControl>
          </Box>
          <Alert severity="info" sx={{ mt: 5 }}>
            Dollar goals, scenario assumptions, and your minimum cash buffer stay separate from
            transaction truth. You can tune them after the first dashboard is calculated.
          </Alert>
          {error ? (
            <Alert severity="error" sx={{ mt: 3 }}>
              {error}
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </Box>
  );
}

function CashFlowStep({
  value,
  onChange,
  source,
  error,
}: {
  value: CashFlowForm;
  onChange: (value: CashFlowForm) => void;
  source: SourceChoice;
  error: string | null;
}) {
  return (
    <Box>
      <Typography component="h1" variant="h1">
        Give the next paycheck a job
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 2 }}>
        Optional estimates are saved as editable planning records. Blank fields stay unknown;
        BetterWealth will not fill them with demo values.
      </Typography>
      {source === "simplefin" ? (
        <Alert severity="success" sx={{ mt: 4 }}>
          Your initial SimpleFIN sync is queued. These cash-flow estimates help before enough
          transaction history arrives.
        </Alert>
      ) : null}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "repeat(2, 1fr)" },
          gap: 4,
          mt: 7,
        }}
      >
        <Card>
          <CardContent sx={{ p: 5 }}>
            <Stack direction="row" alignItems="center" gap={2}>
              <AccountBalanceRounded color="secondary" />
              <Typography variant="h3">Income timing</Typography>
            </Stack>
            <Stack gap={4} sx={{ mt: 5 }}>
              <TextField
                label="Net pay per paycheck"
                value={value.netPay}
                onChange={(event) => onChange({ ...value, netPay: event.target.value })}
                placeholder="Leave blank if unknown"
                inputProps={{ inputMode: "decimal" }}
                InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
              />
              <FormControl size="small">
                <InputLabel id="cadence-label">Pay cadence</InputLabel>
                <Select
                  labelId="cadence-label"
                  label="Pay cadence"
                  value={value.cadence}
                  onChange={(event) => onChange({ ...value, cadence: event.target.value })}
                >
                  <MenuItem value="weekly">Weekly</MenuItem>
                  <MenuItem value="biweekly">Every two weeks</MenuItem>
                  <MenuItem value="semimonthly">Twice monthly</MenuItem>
                  <MenuItem value="monthly">Monthly</MenuItem>
                </Select>
              </FormControl>
              <TextField
                label="Next expected payday"
                type="date"
                value={value.nextPayday}
                onChange={(event) => onChange({ ...value, nextPayday: event.target.value })}
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <TextField
                label="Minimum cash buffer"
                value={value.minimumBuffer}
                onChange={(event) => onChange({ ...value, minimumBuffer: event.target.value })}
                inputProps={{ inputMode: "decimal" }}
                InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
                helperText="Protected before BetterWealth calls anything safe to spend"
              />
            </Stack>
          </CardContent>
        </Card>
        <Card>
          <CardContent sx={{ p: 5 }}>
            <Stack direction="row" alignItems="center" gap={2}>
              <InsightsRounded color="info" />
              <Typography variant="h3">Near-term obligations</Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              Enter only required bills due before that payday. Enter $0 to explicitly confirm none,
              or leave it blank if you do not know yet.
            </Typography>
            <TextField
              fullWidth
              label="Required bills before payday"
              value={value.billsBeforePayday}
              onChange={(event) => onChange({ ...value, billsBeforePayday: event.target.value })}
              placeholder="Blank means unknown"
              inputProps={{ inputMode: "decimal" }}
              InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
              sx={{ mt: 5 }}
            />
            <Alert severity="warning" sx={{ mt: 4 }}>
              Safe to spend remains incomplete until balances, income, upcoming bills, and envelope
              commitments are confirmed.
            </Alert>
          </CardContent>
        </Card>
      </Box>
      {error ? (
        <Alert severity="error" sx={{ mt: 4 }}>
          {error}
        </Alert>
      ) : null}
    </Box>
  );
}

function ReadyStep({ source, syncState }: { source: SourceChoice; syncState: string | undefined }) {
  const dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: api.dashboard,
    enabled: source !== "demo",
    retry: 1,
    staleTime: 0,
  });
  const report = source === "demo" ? demoDashboard : dashboard.data;

  if (!report && dashboard.isPending) {
    return (
      <Box>
        <Typography component="h1" variant="h1">
          Calculating your first plan
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 2 }}>
          Reading saved balances and planning inputs from the API.
        </Typography>
        <Card sx={{ mt: 7 }}>
          <CardContent sx={{ p: 7 }}>
            <Skeleton variant="text" width="35%" height={28} />
            <Skeleton variant="text" width="55%" height={72} />
            <Skeleton variant="rounded" height={110} sx={{ mt: 4 }} />
          </CardContent>
        </Card>
      </Box>
    );
  }

  if (!report) {
    return (
      <Box>
        <Typography component="h1" variant="h1">
          Your setup is saved
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 2 }}>
          The live dashboard did not load, so no spending estimate is being guessed.
        </Typography>
        <Alert severity="error" sx={{ mt: 6 }}>
          {dashboard.error instanceof Error
            ? dashboard.error.message
            : "The dashboard could not be loaded."}
        </Alert>
        <Button
          variant="outlined"
          startIcon={<RefreshRounded />}
          onClick={() => void dashboard.refetch()}
          sx={{ mt: 4 }}
        >
          Retry dashboard
        </Button>
      </Box>
    );
  }

  const ready = report.trust.state === "ready";
  const stale = report.trust.state === "stale";
  const rawSafeToSpend =
    BigInt(report.availableCash.minorUnits) -
    BigInt(report.reservedBills.minorUnits) -
    BigInt(report.envelopeCommitments.minorUnits) -
    BigInt(report.goalContributions.minorUnits) -
    BigInt(report.minimumBuffer.minorUnits);
  return (
    <Box>
      <Typography component="h1" variant="h1">
        {ready
          ? "Your first plan is ready"
          : stale
            ? "Your plan needs fresh balances"
            : "Your first plan has clear next steps"}
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 2 }}>
        {source === "demo"
          ? "This is Alex’s fictional, fully reconciled fixture."
          : report.trust.confidenceLabel}
      </Typography>
      {source === "simplefin" && syncState ? (
        <Alert severity="info" sx={{ mt: 4 }}>
          SimpleFIN initial sync: {syncState}. Refresh once imported accounts finish processing.
        </Alert>
      ) : null}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "1.15fr 0.85fr" },
          gap: 5,
          mt: 7,
        }}
      >
        <Card
          sx={{
            color: "#fff",
            border: 0,
            background: "linear-gradient(125deg, #1C3558, #236272 58%, #1A8A69 120%)",
          }}
        >
          <CardContent sx={{ p: { xs: 5, sm: 7 } }}>
            <Stack direction="row" justifyContent="space-between" gap={3} alignItems="center">
              <Typography variant="body2" sx={{ color: "rgba(255,255,255,.72)", fontWeight: 650 }}>
                {ready ? "Safe to spend" : "Current estimate · not yet decision-ready"}
              </Typography>
              <Chip
                label={
                  report.trust.state === "ready"
                    ? "Ready"
                    : report.trust.state === "stale"
                      ? "Stale"
                      : "Incomplete"
                }
                size="small"
                sx={{ color: "#fff", bgcolor: "rgba(255,255,255,.14)" }}
              />
            </Stack>
            <Typography
              sx={{
                mt: 2,
                fontSize: { xs: 40, sm: 52 },
                fontWeight: 750,
                letterSpacing: "-0.05em",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {formatMoney(report.safeToSpend)}
            </Typography>
            <Typography sx={{ color: "rgba(255,255,255,.75)" }}>
              {formatMoney(report.safePerDay)} per day through {formatDate(report.coveredThrough)}
            </Typography>
            <Divider sx={{ my: 5, borderColor: "rgba(255,255,255,.14)" }} />
            <Typography variant="body2" sx={{ color: "rgba(255,255,255,.78)", lineHeight: 1.8 }}>
              Available cash {formatMoney(report.availableCash)} − reserved bills{" "}
              {formatMoney(report.reservedBills)} − envelopes{" "}
              {formatMoney(report.envelopeCommitments)} − goals{" "}
              {formatMoney(report.goalContributions)} − minimum buffer{" "}
              {formatMoney(report.minimumBuffer)}
            </Typography>
            <Typography
              variant="caption"
              sx={{ display: "block", mt: 2, color: "rgba(255,255,255,.68)" }}
            >
              {rawSafeToSpend < 0n
                ? `The formula is ${formatMoney({ minorUnits: rawSafeToSpend.toString(), currency: report.safeToSpend.currency })}; safe to spend is floored at ${formatMoney({ minorUnits: "0", currency: report.safeToSpend.currency })}.`
                : `The five terms above reconcile exactly to ${formatMoney(report.safeToSpend)}.`}
            </Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent sx={{ p: 5 }}>
            <Typography variant="h3">Readiness from your data</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              As of {formatDate(report.trust.asOf)}
            </Typography>
            <Stack gap={3} sx={{ mt: 5 }}>
              <Stack direction="row" gap={2} alignItems="center">
                {ready ? (
                  <CheckCircleRounded sx={{ color: "success.main", fontSize: 20 }} />
                ) : (
                  <WarningAmberRounded
                    sx={{ color: stale ? "error.main" : "warning.main", fontSize: 20 }}
                  />
                )}
                <Typography variant="body2" fontWeight={700}>
                  {ready
                    ? "All decision inputs are confirmed"
                    : `${report.trust.missingInputs.length} input${report.trust.missingInputs.length === 1 ? "" : "s"} still ${report.trust.missingInputs.length === 1 ? "needs" : "need"} attention`}
                </Typography>
              </Stack>
              {report.trust.missingInputs.map((item) => (
                <Stack key={item} direction="row" gap={2} alignItems="flex-start">
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      mt: 0.75,
                      borderRadius: "50%",
                      bgcolor: "warning.main",
                      flex: "0 0 auto",
                    }}
                  />
                  <Typography variant="body2" color="text.secondary">
                    {item}
                  </Typography>
                </Stack>
              ))}
            </Stack>
            {!ready && report.trust.missingInputs.length ? (
              <Alert severity="warning" sx={{ mt: 4 }}>
                These are real missing inputs, not a simulated completion score. The dashboard will
                keep each gap visible until you provide it.
              </Alert>
            ) : null}
            {source !== "demo" ? (
              <Button
                variant="outlined"
                startIcon={<RefreshRounded />}
                disabled={dashboard.isFetching}
                onClick={() => void dashboard.refetch()}
                sx={{ mt: 5 }}
              >
                {dashboard.isFetching ? "Refreshing…" : "Refresh numbers"}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<SourceChoice>("simplefin");
  const [setupToken, setSetupToken] = useState("");
  const [manual, setManual] = useState<ManualAccountForm>({
    name: "Everyday checking",
    openingBalance: "",
  });
  const [target, setTarget] = useState<TargetForm>({
    birthDate: defaultBirthDate(),
    targetAge: "30",
    targetLiquidNetWorth: "250000",
    currency: "USD",
  });
  const [cashFlow, setCashFlow] = useState<CashFlowForm>({
    netPay: "",
    cadence: "biweekly",
    nextPayday: isoDateOffset(14),
    billsBeforePayday: "",
    minimumBuffer: "1000",
  });
  const manualAccountId = useRef<string | undefined>(undefined);
  const incomeSourceId = useRef<string | undefined>(undefined);
  const billId = useRef<string | undefined>(undefined);

  const claim = useMutation({
    mutationFn: () => api.claimSimpleFin({ setupToken: setupToken.trim() }),
  });
  const saveTarget = useMutation({
    mutationFn: async () => {
      const targetMinorUnits = moneyMinorUnits(target.targetLiquidNetWorth);
      if (targetMinorUnits === null || BigInt(targetMinorUnits) <= 0n)
        throw new Error("Enter a positive liquid wealth target.");
      await Promise.all([
        api.updateProfile({
          birthDate: target.birthDate,
          targetAge: Number(target.targetAge),
          baseCurrency: target.currency,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        }),
        api.updateDashboardPreferences({
          targetLiquidNetWorth: { minorUnits: targetMinorUnits, currency: target.currency },
        }),
      ]);
    },
  });
  const savePlanningInputs = useMutation({
    mutationFn: async () => {
      if (source === "manual" && !manualAccountId.current) {
        const created = await api.createAccount({
          name: manual.name.trim(),
          group: "cash",
          type: "checking",
          currency: target.currency,
          balanceMinorUnits: moneyMinorUnits(manual.openingBalance) ?? "0",
          includeInBudget: true,
        });
        manualAccountId.current = created.id;
      }

      const netPay = moneyMinorUnits(cashFlow.netPay);
      if (netPay !== null && BigInt(netPay) > 0n) {
        const input = {
          name: "Primary paycheck estimate",
          cadence: cashFlow.cadence,
          typicalAmount: { minorUnits: netPay, currency: target.currency },
          nextExpectedDate: cashFlow.nextPayday,
          isActive: true,
        };
        if (incomeSourceId.current) await api.updateIncomeSource(incomeSourceId.current, input);
        else incomeSourceId.current = (await api.createIncomeSource(input)).id;
      }

      const bills = moneyMinorUnits(cashFlow.billsBeforePayday);
      if (bills !== null && BigInt(bills) > 0n) {
        const input = {
          name: "Required bills estimate",
          amountMin: { minorUnits: bills, currency: target.currency },
          amountMax: { minorUnits: bills, currency: target.currency },
          nextDueDate: cashFlow.nextPayday,
          dueRule: {
            cadence: "one_time_estimate",
            windowEndsOn: cashFlow.nextPayday,
            reviewAfter: cashFlow.nextPayday,
          },
          isRequired: true,
          isActive: true,
        };
        if (billId.current) await api.updateBill(billId.current, input);
        else billId.current = (await api.createBill(input)).id;
      }

      const minimumBuffer = moneyMinorUnits(cashFlow.minimumBuffer);
      if (minimumBuffer === null)
        throw new Error("Enter the minimum cash buffer you want protected.");
      await api.updateDashboardPreferences({
        minimumBuffer: { minorUnits: minimumBuffer, currency: target.currency },
        ...(bills === null
          ? {}
          : {
              reservedBills:
                BigInt(bills) === 0n ? { minorUnits: "0", currency: target.currency } : null,
            }),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["profile"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-preferences"] }),
        queryClient.invalidateQueries({ queryKey: ["income-sources"] }),
        queryClient.invalidateQueries({ queryKey: ["bills"] }),
      ]);
    },
  });

  const isLast = step === steps.length - 1;
  const currentAge = ageOnDate(target.birthDate);
  const targetValid =
    /^\d{4}-\d{2}-\d{2}$/.test(target.birthDate) &&
    currentAge !== null &&
    Number.isInteger(Number(target.targetAge)) &&
    Number(target.targetAge) > currentAge &&
    Number(target.targetAge) <= 120 &&
    moneyMinorUnits(target.targetLiquidNetWorth) !== null &&
    BigInt(moneyMinorUnits(target.targetLiquidNetWorth) ?? "0") > 0n;
  const manualValid =
    source !== "manual" ||
    (manual.name.trim().length > 0 && moneyMinorUnits(manual.openingBalance) !== null);
  const parsedNetPay = moneyMinorUnits(cashFlow.netPay);
  const parsedBills = moneyMinorUnits(cashFlow.billsBeforePayday);
  const cashValid =
    (!cashFlow.netPay.trim() || (parsedNetPay !== null && BigInt(parsedNetPay) > 0n)) &&
    (!cashFlow.billsBeforePayday.trim() || parsedBills !== null) &&
    moneyMinorUnits(cashFlow.minimumBuffer) !== null &&
    /^\d{4}-\d{2}-\d{2}$/.test(cashFlow.nextPayday);
  const busy = claim.isPending || saveTarget.isPending || savePlanningInputs.isPending;

  const goForward = () => {
    setStep((value) => value + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const next = async () => {
    if (step === 0) {
      if (source === "demo") {
        window.sessionStorage.setItem("bw-demo", "true");
        setStep(3);
        return;
      }
      window.sessionStorage.removeItem("bw-demo");
      if (source === "simplefin") {
        try {
          if (!claim.data) {
            await claim.mutateAsync();
            setSetupToken("");
          }
        } catch {
          return;
        }
      }
      goForward();
      return;
    }
    if (step === 1) {
      try {
        await saveTarget.mutateAsync();
      } catch {
        return;
      }
      goForward();
      return;
    }
    if (step === 2) {
      try {
        await savePlanningInputs.mutateAsync();
      } catch {
        return;
      }
      goForward();
      return;
    }
    navigate("/today", { replace: true });
  };

  const back = () => {
    if (step === 0) navigate("/today");
    else if (step === 3 && source === "demo") setStep(0);
    else setStep((value) => value - 1);
  };

  const buttonDisabled =
    busy ||
    (step === 0 &&
      ((source === "simplefin" && !setupToken.trim() && !claim.data) || !manualValid)) ||
    (step === 1 && !targetValid) ||
    (step === 2 && !cashValid);
  const buttonLabel = claim.isPending
    ? "Claiming…"
    : saveTarget.isPending || savePlanningInputs.isPending
      ? "Saving…"
      : isLast
        ? source === "demo"
          ? "Open demo dashboard"
          : "Open dashboard with next steps"
        : source === "demo" && step === 0
          ? "Open demo plan"
          : "Continue";

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <Box
        component="header"
        sx={{
          height: 72,
          px: { xs: 4, sm: 7 },
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          bgcolor: "background.paper",
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Brand />
        <Stack direction="row" alignItems="center" gap={2}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: { xs: "none", sm: "block" } }}
          >
            Private setup
          </Typography>
          <LockRounded sx={{ color: "success.main", fontSize: 18 }} />
        </Stack>
      </Box>
      <Box sx={{ borderBottom: "1px solid", borderColor: "divider", bgcolor: "background.paper" }}>
        <LinearProgress
          variant="determinate"
          value={((step + 1) / steps.length) * 100}
          aria-label={`Setup step ${step + 1} of ${steps.length}`}
          sx={{ height: 3 }}
        />
        <Stack direction="row" justifyContent="center" gap={{ xs: 1, sm: 5 }} sx={{ px: 3, py: 3 }}>
          {steps.map((label, index) => (
            <Stack key={label} direction="row" alignItems="center" gap={1}>
              <Box
                sx={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 11,
                  fontWeight: 750,
                  bgcolor: index <= step ? "secondary.main" : "action.hover",
                  color: index <= step ? "#fff" : "text.secondary",
                }}
              >
                {index < step ? "✓" : index + 1}
              </Box>
              <Typography
                variant="caption"
                color={index <= step ? "text.primary" : "text.secondary"}
                sx={{
                  display: { xs: index === step ? "block" : "none", sm: "block" },
                  fontWeight: index === step ? 750 : 500,
                }}
              >
                {label}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </Box>
      <Box
        component="main"
        sx={{
          width: "100%",
          maxWidth: 1120,
          mx: "auto",
          px: { xs: 4, sm: 7 },
          py: { xs: 8, sm: 12 },
          pb: 28,
        }}
      >
        {step === 0 ? (
          <StartStep
            source={source}
            setSource={setSource}
            setupToken={setupToken}
            setSetupToken={setSetupToken}
            manual={manual}
            setManual={setManual}
            claimError={claim.error instanceof Error ? claim.error.message : null}
          />
        ) : null}
        {step === 1 ? (
          <TargetStep
            value={target}
            onChange={setTarget}
            error={
              saveTarget.error instanceof Error
                ? saveTarget.error.message
                : currentAge === null
                  ? "Enter a valid birth date that is not in the future."
                  : Number(target.targetAge) <= currentAge
                    ? "Your target age must be later than your current age."
                    : moneyMinorUnits(target.targetLiquidNetWorth) === null ||
                        BigInt(moneyMinorUnits(target.targetLiquidNetWorth) ?? "0") <= 0n
                      ? "Enter a positive target with no more than two decimal places."
                      : null
            }
          />
        ) : null}
        {step === 2 ? (
          <CashFlowStep
            value={cashFlow}
            onChange={setCashFlow}
            source={source}
            error={
              savePlanningInputs.error instanceof Error
                ? savePlanningInputs.error.message
                : cashFlow.netPay.trim() && (parsedNetPay === null || BigInt(parsedNetPay) <= 0n)
                  ? "Net pay must be greater than zero with no more than two decimal places."
                  : cashFlow.billsBeforePayday.trim() && parsedBills === null
                    ? "Bills must be zero or greater with no more than two decimal places."
                    : moneyMinorUnits(cashFlow.minimumBuffer) === null
                      ? "Minimum buffer must be zero or greater with no more than two decimal places."
                      : null
            }
          />
        ) : null}
        {step === 3 ? <ReadyStep source={source} syncState={claim.data?.sync.state} /> : null}
      </Box>
      <Box
        sx={{
          position: "fixed",
          zIndex: 10,
          inset: "auto 0 0 0",
          px: { xs: 4, sm: 7 },
          py: 4,
          bgcolor: (theme) => alpha(theme.palette.background.paper, 0.9),
          backdropFilter: "blur(14px)",
          borderTop: "1px solid",
          borderColor: "divider",
        }}
      >
        <Stack direction="row" justifyContent="space-between" sx={{ maxWidth: 1120, mx: "auto" }}>
          <Button startIcon={<ArrowBackRounded />} onClick={back}>
            {step === 0 ? "Skip for now" : "Back"}
          </Button>
          <Button
            variant="contained"
            endIcon={<ArrowForwardRounded />}
            disabled={buttonDisabled}
            onClick={() => void next()}
          >
            {buttonLabel}
          </Button>
        </Stack>
      </Box>
    </Box>
  );
}
