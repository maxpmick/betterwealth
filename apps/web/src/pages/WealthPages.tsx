import { deriveGoalPace } from "@betterwealth/shared/goal-insights";
import {
  AccountBalanceRounded,
  AddRounded,
  ArchiveRounded,
  ArrowForwardRounded,
  CheckCircleRounded,
  DeleteOutlineRounded,
  DirectionsCarRounded,
  DragIndicatorRounded,
  EditRounded,
  ExpandMoreRounded,
  FlagRounded,
  HomeRounded,
  KeyboardArrowDownRounded,
  KeyboardArrowUpRounded,
  PauseRounded,
  PaymentsRounded,
  PlayArrowRounded,
  SavingsRounded,
  ShieldRounded,
  ShoppingBagRounded,
  TrendingDownRounded,
  TrendingUpRounded,
  UpdateRounded,
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
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  InputLabel,
  Link,
  MenuItem,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  useTheme,
} from "@mui/material";
import { LineChart } from "@mui/x-charts/LineChart";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import {
  type ApiAccount,
  type ApiAsset,
  type ApiAssetValuation,
  type ApiGoal,
  type ApiGoalContribution,
  type ApiGoalPatch,
  api,
  type ComfortablePurchasePlan,
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
  ProgressMeter,
  SectionHeader,
  StatusChip,
} from "../components/ui";
import { usePrivacy } from "../contexts";
import { isDemoMode } from "../demo";
import {
  demoGoals as demoApiGoals,
  demoAssets,
  demoAccounts as demoGoalAccounts,
  demoNetWorth,
} from "../demoApi";
import { chartTickFormatter, formatMoneyExact, minorToMajor } from "../lib/money";

type WealthHistoryPoint = {
  id: string;
  month: string;
  total: number;
  liquid: number;
  investable?: number;
  retirement?: number;
  assets?: number;
  debts?: number;
};
type WealthMetric = Exclude<keyof WealthHistoryPoint, "id" | "month">;

const wealthMetrics: Array<{ key: WealthMetric; label: string }> = [
  { key: "total", label: "Total" },
  { key: "liquid", label: "Liquid" },
  { key: "investable", label: "Investable" },
  { key: "retirement", label: "Retirement" },
  { key: "assets", label: "Assets" },
  { key: "debts", label: "Debts" },
];

function WealthHistoryChart({
  history,
  range,
  setRange,
  currency,
}: {
  history: WealthHistoryPoint[];
  range: string;
  setRange: (range: string) => void;
  currency: string;
}) {
  const { privacyEnabled } = usePrivacy();
  const theme = useTheme();
  const [metric, setMetric] = useState<WealthMetric>("total");
  const metricColors: Record<WealthMetric, string> = {
    total: theme.palette.primary.main,
    liquid: theme.palette.success.main,
    investable: theme.palette.info.main,
    retirement: theme.palette.secondary.main,
    assets: theme.palette.warning.main,
    debts: theme.palette.error.main,
  };
  const selected = wealthMetrics.find((item) => item.key === metric) ?? {
    key: "total" as const,
    label: "Total",
  };
  const metricAvailable = (key: WealthMetric) =>
    history.some((point) => typeof point[key] === "number");
  const values = history
    .map((point) => point[metric])
    .filter((value): value is number => typeof value === "number");
  return (
    <Card>
      <CardContent sx={{ p: { xs: 4, sm: 5 } }}>
        <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={3}>
          <Box>
            <Typography component="h2" variant="h6">
              Wealth history
            </Typography>
          </Box>
          <Stack direction="row" flexWrap="wrap" gap={1}>
            {wealthMetrics.map((item) => (
              <Chip
                key={item.key}
                label={item.label}
                clickable
                disabled={!metricAvailable(item.key)}
                color={metric === item.key ? "primary" : "default"}
                onClick={() => setMetric(item.key)}
              />
            ))}
          </Stack>
        </Stack>
        <Stack direction="row" justifyContent="flex-end" sx={{ mt: 3 }}>
          {["1M", "3M", "1Y", "All"].map((item) => (
            <Button
              key={item}
              size="small"
              color={range === item ? "primary" : "inherit"}
              onClick={() => setRange(item)}
              sx={{ minWidth: 44 }}
            >
              {item}
            </Button>
          ))}
        </Stack>
        <Box sx={{ mt: 2 }}>
          {privacyEnabled ? (
            <ChartMaskedState />
          ) : (
            <LineChart
              height={330}
              dataset={history}
              xAxis={[
                {
                  dataKey: "id",
                  scaleType: "point",
                  valueFormatter: (value: string) =>
                    history.find((point) => point.id === value)?.month ?? value,
                },
              ]}
              yAxis={[
                {
                  valueFormatter: chartTickFormatter(currency),
                  width: 48,
                },
              ]}
              series={[
                {
                  dataKey: metric,
                  label: selected.label,
                  area: true,
                  showMark: false,
                  color: metricColors[selected.key],
                  valueFormatter: (value: number | null) =>
                    formatMoney(Number(value ?? 0), currency),
                },
              ]}
              grid={{ horizontal: true }}
              margin={{ left: 4, right: 16, top: 18, bottom: 8 }}
            />
          )}
        </Box>
        <Typography variant="body2" color="text.secondary">
          {privacyEnabled
            ? "Chart values are hidden."
            : values.length
              ? `${selected.label} moved from ${(values[0] ?? 0).toLocaleString("en-US", { style: "currency", currency, maximumFractionDigits: 0 })} to ${(values.at(-1) ?? 0).toLocaleString("en-US", { style: "currency", currency, maximumFractionDigits: 0 })} in this range.`
              : `No ${selected.label.toLowerCase()} snapshots in this range.`}
        </Typography>
        <Accordion disableGutters elevation={0} sx={{ mt: 2, "&::before": { display: "none" } }}>
          <AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ px: 0 }}>
            <Typography variant="body2" fontWeight={700}>
              View data table
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 0, overflowX: "auto" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Month</TableCell>
                  <TableCell align="right">Total</TableCell>
                  <TableCell align="right">{selected.label}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {history.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.month}</TableCell>
                    <TableCell align="right">
                      <Money value={row.total} currency={currency} />
                    </TableCell>
                    <TableCell align="right">
                      {typeof row[metric] === "number" ? (
                        <Money value={row[metric]} currency={currency} />
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </AccordionDetails>
        </Accordion>
      </CardContent>
    </Card>
  );
}

export function dollarsToMinor(value: string): string | null {
  const normalized = value.trim().replaceAll(",", "");
  const match = /^(?:0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0")).toString();
}

type AssetDraft = {
  name: string;
  type: ApiAsset["type"];
  liquidityClass: ApiAsset["liquidityClass"];
  value: string;
  valuedOn: string;
  confidence: ApiAsset["confidence"];
};

function emptyAssetDraft(): AssetDraft {
  return {
    name: "",
    type: "vehicle",
    liquidityClass: "illiquid",
    value: "",
    valuedOn: new Date().toISOString().slice(0, 10),
    confidence: "medium",
  };
}

function assetIcon(asset: Pick<ApiAsset, "type">) {
  if (asset.type === "vehicle") return <DirectionsCarRounded />;
  if (asset.type === "property") return <HomeRounded />;
  if (asset.type === "business") return <AccountBalanceRounded />;
  return <SavingsRounded />;
}

function assetFreshness(valuedAt: string) {
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(valuedAt).getTime()) / 86_400_000));
  if (ageDays <= 45) return { label: "Fresh", tone: "positive" as const };
  if (ageDays <= 365)
    return { label: `${Math.max(1, Math.round(ageDays / 30))}mo old`, tone: "warning" as const };
  return { label: `${Math.round(ageDays / 365)}y old`, tone: "risk" as const };
}

function AssetEditorDialog({
  open,
  editing,
  draft,
  setDraft,
  saving,
  deleting,
  error,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  editing: boolean;
  draft: AssetDraft;
  setDraft: (draft: AssetDraft) => void;
  saving: boolean;
  deleting: boolean;
  error: string | null;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
}) {
  const valueMinor = dollarsToMinor(draft.value);
  const invalidValue =
    !editing && draft.value.trim().length > 0 && (valueMinor === null || BigInt(valueMinor) <= 0n);
  const valid =
    draft.name.trim().length > 0 && (editing || (valueMinor !== null && BigInt(valueMinor) > 0n));
  return (
    <Dialog open={open} onClose={saving || deleting ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? "Edit asset details" : "Add a valued asset"}</DialogTitle>
      <DialogContent>
        <Stack gap={3} sx={{ mt: 1 }}>
          <TextField
            autoFocus
            label="Asset name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="2019 Honda Civic"
          />
          <FormControl size="small">
            <InputLabel id="asset-type-label">Asset type</InputLabel>
            <Select
              labelId="asset-type-label"
              label="Asset type"
              value={draft.type}
              onChange={(event) =>
                setDraft({ ...draft, type: event.target.value as ApiAsset["type"] })
              }
            >
              {["property", "vehicle", "business", "collectible", "custom"].map((value) => (
                <MenuItem key={value} value={value}>
                  {value.charAt(0).toUpperCase() + value.slice(1)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small">
            <InputLabel id="asset-liquidity-label">Liquidity</InputLabel>
            <Select
              labelId="asset-liquidity-label"
              label="Liquidity"
              value={draft.liquidityClass}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  liquidityClass: event.target.value as ApiAsset["liquidityClass"],
                })
              }
            >
              <MenuItem value="liquid">Liquid</MenuItem>
              <MenuItem value="restricted">Restricted</MenuItem>
              <MenuItem value="illiquid">Illiquid</MenuItem>
            </Select>
          </FormControl>
          {!editing ? (
            <>
              <TextField
                label="Current value"
                value={draft.value}
                onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                inputProps={{ inputMode: "decimal" }}
                InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
                error={invalidValue}
                helperText={
                  invalidValue ? "Enter a positive amount with no more than 2 decimals." : undefined
                }
              />
              <TextField
                label="Valuation date"
                type="date"
                value={draft.valuedOn}
                onChange={(event) => setDraft({ ...draft, valuedOn: event.target.value })}
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <FormControl size="small">
                <InputLabel id="asset-confidence-label">Confidence</InputLabel>
                <Select
                  labelId="asset-confidence-label"
                  label="Confidence"
                  value={draft.confidence}
                  onChange={(event) =>
                    setDraft({ ...draft, confidence: event.target.value as ApiAsset["confidence"] })
                  }
                >
                  <MenuItem value="high">High — appraised or known</MenuItem>
                  <MenuItem value="medium">Medium — solid estimate</MenuItem>
                  <MenuItem value="low">Low — rough estimate</MenuItem>
                </Select>
              </FormControl>
            </>
          ) : (
            <Alert severity="info">
              Use “Update value” on the asset card to preserve a valuation history instead of
              overwriting the latest amount.
            </Alert>
          )}
        </Stack>
      </DialogContent>
      {error ? (
        <Alert severity="error" sx={{ mx: 3 }}>
          {error}
        </Alert>
      ) : null}
      <DialogActions sx={{ justifyContent: editing ? "space-between" : "flex-end" }}>
        {editing && onDelete ? (
          <Button
            color="error"
            startIcon={<DeleteOutlineRounded />}
            disabled={saving || deleting}
            onClick={onDelete}
          >
            {deleting ? "Removing…" : "Remove asset"}
          </Button>
        ) : null}
        <Stack direction="row" gap={1}>
          <Button color="inherit" disabled={saving || deleting} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="contained" disabled={!valid || saving || deleting} onClick={onSave}>
            {saving ? "Saving…" : editing ? "Save details" : "Add asset"}
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}

function ValuationDialog({
  open,
  assets,
  selectedId,
  setSelectedId,
  amount,
  setAmount,
  valuedOn,
  setValuedOn,
  source,
  setSource,
  reference,
  setReference,
  confidence,
  setConfidence,
  history,
  historyLoading,
  saving,
  error,
  onClose,
  onSave,
  onCreateAsset,
}: {
  open: boolean;
  assets: ApiAsset[];
  selectedId: string;
  setSelectedId: (id: string) => void;
  amount: string;
  setAmount: (value: string) => void;
  valuedOn: string;
  setValuedOn: (value: string) => void;
  source: ApiAssetValuation["source"];
  setSource: (source: ApiAssetValuation["source"]) => void;
  reference: string;
  setReference: (reference: string) => void;
  confidence: ApiAsset["confidence"];
  setConfidence: (confidence: ApiAsset["confidence"]) => void;
  history: ApiAssetValuation[];
  historyLoading: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: () => void;
  onCreateAsset: () => void;
}) {
  const selected = assets.find((asset) => asset.id === selectedId);
  const amountMinor = dollarsToMinor(amount);
  const invalidAmount = amount.trim().length > 0 && amountMinor === null;
  const valid =
    Boolean(selected) && amountMinor !== null && BigInt(amountMinor) >= 0n && Boolean(valuedOn);
  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Record a new valuation</DialogTitle>
      <DialogContent>
        {assets.length ? (
          <Stack gap={3} sx={{ mt: 1 }}>
            <FormControl size="small">
              <InputLabel id="valuation-asset-label">Asset</InputLabel>
              <Select
                labelId="valuation-asset-label"
                label="Asset"
                value={selectedId}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {assets.map((asset) => (
                  <MenuItem key={asset.id} value={asset.id}>
                    {asset.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              autoFocus
              label="Estimated value"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputProps={{ inputMode: "decimal" }}
              InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
              error={invalidAmount}
              helperText={
                invalidAmount
                  ? "Enter a nonnegative amount with no more than 2 decimals."
                  : undefined
              }
            />
            <TextField
              label="Valuation date"
              type="date"
              value={valuedOn}
              onChange={(event) => setValuedOn(event.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <Stack direction={{ xs: "column", sm: "row" }} gap={3}>
              <FormControl size="small" fullWidth>
                <InputLabel id="valuation-source-label">Source</InputLabel>
                <Select
                  labelId="valuation-source-label"
                  label="Source"
                  value={source}
                  onChange={(event) => setSource(event.target.value as ApiAssetValuation["source"])}
                >
                  <MenuItem value="manual">My estimate</MenuItem>
                  <MenuItem value="provider">External estimate (entered manually)</MenuItem>
                  <MenuItem value="appraisal">Appraisal</MenuItem>
                  <MenuItem value="import">Imported</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" fullWidth>
                <InputLabel id="valuation-confidence-label">Confidence</InputLabel>
                <Select
                  labelId="valuation-confidence-label"
                  label="Confidence"
                  value={confidence}
                  onChange={(event) => setConfidence(event.target.value as ApiAsset["confidence"])}
                >
                  <MenuItem value="high">High</MenuItem>
                  <MenuItem value="medium">Medium</MenuItem>
                  <MenuItem value="low">Low</MenuItem>
                </Select>
              </FormControl>
            </Stack>
            <TextField
              label="Source link or note (optional)"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              inputProps={{ maxLength: 500 }}
              helperText="Paste the source link and enter its estimate above; BetterWealth records the dated value but does not scrape the provider."
            />
            <Box sx={{ p: 2, borderRadius: 1, bgcolor: "action.hover" }}>
              <Typography variant="body2" fontWeight={700}>
                Valuation history
              </Typography>
              {historyLoading ? (
                <Typography variant="caption" color="text.secondary">
                  Loading prior values…
                </Typography>
              ) : history.length ? (
                <Stack gap={1.25} sx={{ mt: 2 }}>
                  {history.slice(0, 4).map((valuation) => (
                    <Stack key={valuation.id} gap={0.5}>
                      <Stack direction="row" justifyContent="space-between">
                        <Typography variant="caption" color="text.secondary">
                          {new Date(`${valuation.valuedOn}T12:00:00`).toLocaleDateString()} ·{" "}
                          {valuation.source}
                        </Typography>
                        <Typography variant="caption" fontWeight={700}>
                          <Money
                            value={minorToMajor(
                              valuation.amount.minorUnits,
                              valuation.amount.currency,
                            )}
                            currency={valuation.amount.currency}
                          />
                        </Typography>
                      </Stack>
                      {valuation.providerReference ? (
                        /^https?:\/\//i.test(valuation.providerReference) ? (
                          <Link
                            href={valuation.providerReference}
                            target="_blank"
                            rel="noreferrer"
                            variant="caption"
                            sx={{ overflowWrap: "anywhere" }}
                          >
                            {valuation.providerReference}
                          </Link>
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            {valuation.providerReference}
                          </Typography>
                        )
                      ) : null}
                    </Stack>
                  ))}
                </Stack>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  This will be the first dated valuation.
                </Typography>
              )}
            </Box>
          </Stack>
        ) : (
          <EmptyState
            icon={<HomeRounded />}
            title="Add an asset first"
            description="Add a manually tracked asset before recording a valuation."
            actionLabel="Add asset"
            onAction={onCreateAsset}
          />
        )}
      </DialogContent>
      {error ? (
        <Alert severity="error" sx={{ mx: 3 }}>
          {error}
        </Alert>
      ) : null}
      <DialogActions>
        <Button color="inherit" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        {assets.length ? (
          <Button variant="contained" disabled={!valid || saving} onClick={onSave}>
            {saving ? "Recording…" : "Record valuation"}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}

export function NetWorthPage() {
  const [range, setRange] = useState("1Y");
  const [assetDialogOpen, setAssetDialogOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<ApiAsset | null>(null);
  const [assetDraft, setAssetDraft] = useState<AssetDraft>(emptyAssetDraft);
  const [valuationOpen, setValuationOpen] = useState(false);
  const [valuationAssetId, setValuationAssetId] = useState("");
  const [valuationAmount, setValuationAmount] = useState("");
  const [valuationDate, setValuationDate] = useState(new Date().toISOString().slice(0, 10));
  const [valuationSource, setValuationSource] = useState<ApiAssetValuation["source"]>("manual");
  const [valuationReference, setValuationReference] = useState("");
  const [valuationConfidence, setValuationConfidence] = useState<ApiAsset["confidence"]>("medium");
  const demo = isDemoMode();
  const queryClient = useQueryClient();
  const reportQuery = useQuery({
    queryKey: ["net-worth", range],
    queryFn: () => api.netWorthReport(range),
    initialData: demo ? demoNetWorth : undefined,
    enabled: !demo,
    retry: 1,
  });
  const assetsQuery = useQuery({
    queryKey: ["assets"],
    queryFn: api.assets,
    initialData: demo ? demoAssets : undefined,
    enabled: !demo,
    retry: 1,
  });
  const selectedAsset = assetsQuery.data?.data.find((asset) => asset.id === valuationAssetId);
  const demoValuationHistory: CursorPage<ApiAssetValuation> | undefined =
    demo && selectedAsset
      ? {
          data: [
            {
              id: `valuation-${selectedAsset.id}`,
              assetId: selectedAsset.id,
              amount: selectedAsset.value,
              valuedOn: selectedAsset.valuedAt.slice(0, 10),
              source: "manual",
              confidenceBps:
                selectedAsset.confidence === "high"
                  ? 10_000
                  : selectedAsset.confidence === "medium"
                    ? 7_500
                    : 4_000,
            },
          ],
          page: { cursor: null, hasMore: false },
        }
      : undefined;
  const valuationsQuery = useQuery({
    queryKey: ["asset-valuations", valuationAssetId],
    queryFn: () => api.assetValuations(valuationAssetId),
    initialData: demoValuationHistory,
    enabled: !demo && valuationOpen && Boolean(valuationAssetId),
    retry: 1,
  });

  const refreshWealth = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["assets"] }),
      queryClient.invalidateQueries({ queryKey: ["net-worth"] }),
    ]);
  };
  const createAsset = useMutation({
    mutationFn: () => {
      const valueMinor = dollarsToMinor(assetDraft.value);
      if (valueMinor === null || BigInt(valueMinor) <= 0n) {
        throw new Error("Enter a positive current value with no more than 2 decimal places.");
      }
      return api.createAsset({
        name: assetDraft.name.trim(),
        type: assetDraft.type,
        liquidityClass: assetDraft.liquidityClass,
        currency: "USD",
        value: { minorUnits: valueMinor, currency: "USD" },
        valuedOn: assetDraft.valuedOn,
        valuationSource: "manual",
        confidence: assetDraft.confidence,
        isActive: true,
      });
    },
    onSuccess: async () => {
      setAssetDialogOpen(false);
      setAssetDraft(emptyAssetDraft());
      await refreshWealth();
    },
  });
  const updateAsset = useMutation({
    mutationFn: () => {
      if (!editingAsset) throw new Error("Choose an asset before editing it.");
      return api.updateAsset(editingAsset.id, {
        name: assetDraft.name.trim(),
        type: assetDraft.type,
        liquidityClass: assetDraft.liquidityClass,
      });
    },
    onSuccess: async () => {
      setAssetDialogOpen(false);
      setEditingAsset(null);
      await refreshWealth();
    },
  });
  const deleteAsset = useMutation({
    mutationFn: () => {
      if (!editingAsset) throw new Error("Choose an asset before removing it.");
      return api.deleteAsset(editingAsset.id);
    },
    onSuccess: async () => {
      setAssetDialogOpen(false);
      setEditingAsset(null);
      await refreshWealth();
    },
  });
  const createValuation = useMutation({
    mutationFn: () => {
      const amountMinor = dollarsToMinor(valuationAmount);
      if (amountMinor === null || BigInt(amountMinor) < 0n) {
        throw new Error("Enter a nonnegative value with no more than 2 decimal places.");
      }
      return api.createAssetValuation(valuationAssetId, {
        amount: {
          minorUnits: amountMinor,
          currency: selectedAsset?.value.currency ?? "USD",
        },
        valuedOn: valuationDate,
        source: valuationSource,
        ...(valuationReference.trim() ? { providerReference: valuationReference.trim() } : {}),
        confidenceBps:
          valuationConfidence === "high"
            ? 10_000
            : valuationConfidence === "medium"
              ? 7_500
              : 4_000,
      });
    },
    onSuccess: async () => {
      setValuationOpen(false);
      setValuationAmount("");
      setValuationReference("");
      await Promise.all([
        refreshWealth(),
        queryClient.invalidateQueries({ queryKey: ["asset-valuations", valuationAssetId] }),
      ]);
    },
  });

  const openCreateAsset = () => {
    setEditingAsset(null);
    setAssetDraft(emptyAssetDraft());
    setAssetDialogOpen(true);
  };
  const openEditAsset = (asset: ApiAsset) => {
    setEditingAsset(asset);
    setAssetDraft({
      name: asset.name,
      type: asset.type,
      liquidityClass: asset.liquidityClass,
      value: "",
      valuedOn: new Date().toISOString().slice(0, 10),
      confidence: asset.confidence,
    });
    setAssetDialogOpen(true);
  };
  const openValuation = (asset?: ApiAsset) => {
    const target = asset ?? assetsQuery.data?.data[0];
    setValuationAssetId(target?.id ?? "");
    setValuationAmount(
      target ? String(minorToMajor(target.value.minorUnits, target.value.currency)) : "",
    );
    setValuationDate(new Date().toISOString().slice(0, 10));
    setValuationSource("manual");
    setValuationReference("");
    setValuationConfidence(target?.confidence ?? "medium");
    setValuationOpen(true);
  };
  const mutationError = createAsset.error ?? updateAsset.error ?? deleteAsset.error;

  if (reportQuery.isPending)
    return (
      <Stack gap={4}>
        <PageHeader title="Net worth" />
        <LoadingCard rows={7} />
      </Stack>
    );
  if (reportQuery.isError || !reportQuery.data)
    return (
      <Stack gap={4}>
        <PageHeader title="Net worth" />
        <ErrorState
          message="BetterWealth could not load the net-worth report."
          onRetry={() => reportQuery.refetch()}
        />
      </Stack>
    );
  const report = reportQuery.data;
  const history: WealthHistoryPoint[] = report.series.map((row, index) => ({
    id: `${row.date}-${index}`,
    month: new Date(row.date).toLocaleDateString("en-US", {
      month: "short",
      ...(report.series.length > 12 ? { year: "2-digit" as const } : {}),
    }),
    total: minorToMajor(row.total.minorUnits, row.total.currency),
    liquid: minorToMajor(row.liquid.minorUnits, row.liquid.currency),
    ...(row.investable
      ? { investable: minorToMajor(row.investable.minorUnits, row.investable.currency) }
      : {}),
    ...(row.retirement
      ? { retirement: minorToMajor(row.retirement.minorUnits, row.retirement.currency) }
      : {}),
    ...(row.assets ? { assets: minorToMajor(row.assets.minorUnits, row.assets.currency) } : {}),
    ...(row.debts
      ? { debts: Math.abs(minorToMajor(row.debts.minorUnits, row.debts.currency)) }
      : {}),
  }));
  const liveComposition = report.composition.map((row) => ({
    group: row.group,
    amount: minorToMajor(row.amount.minorUnits, row.amount.currency),
    currency: row.amount.currency,
    change: row.changePercent,
    kind: row.kind === "asset" ? "Asset" : "Debt",
    detail: row.detail ?? row.kind,
  }));
  const assetsList = assetsQuery.data?.data ?? [];
  return (
    <Stack gap={5}>
      <PageHeader
        title="Net worth"
        actions={
          <Button variant="outlined" startIcon={<UpdateRounded />} onClick={() => openValuation()}>
            Add valuation
          </Button>
        }
      />
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr 1fr", lg: "repeat(4, 1fr)" },
          gap: 3,
        }}
      >
        <MetricCard
          label="Total net worth"
          value={
            <Money
              value={minorToMajor(report.total.minorUnits, report.total.currency)}
              currency={report.total.currency}
            />
          }
          helper="Latest dated snapshot"
        />
        <MetricCard
          label="Liquid net worth"
          value={
            <Money
              value={minorToMajor(report.liquid.minorUnits, report.liquid.currency)}
              currency={report.liquid.currency}
            />
          }
          helper="Available outside retirement"
        />
        <MetricCard
          label="Investable"
          value={
            <Money
              value={minorToMajor(report.investable.minorUnits, report.investable.currency)}
              currency={report.investable.currency}
            />
          }
          helper="Brokerage + retirement"
        />
        <MetricCard
          label="Total debt"
          value={
            <Money
              value={Math.abs(minorToMajor(report.debts.minorUnits, report.debts.currency))}
              currency={report.debts.currency}
            />
          }
          helper="Current liabilities"
        />
      </Box>
      <WealthHistoryChart
        history={history}
        range={range}
        setRange={setRange}
        currency={report.total.currency}
      />
      <Card>
        <CardContent sx={{ p: { xs: 4, sm: 5 } }}>
          <SectionHeader title="Composition" />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Change compares each group with the start of the selected period.
          </Typography>
          {liveComposition.length ? (
            <Box sx={{ mt: 4 }}>
              {liveComposition.map((row, index) => (
                <Stack
                  key={row.group}
                  direction="row"
                  alignItems="center"
                  gap={3}
                  sx={{
                    py: 3,
                    borderBottom: index === liveComposition.length - 1 ? 0 : "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <Box
                    sx={{
                      width: 40,
                      height: 40,
                      borderRadius: 1,
                      display: "grid",
                      placeItems: "center",
                      bgcolor: (theme) =>
                        row.kind === "Asset"
                          ? alpha(theme.palette.success.main, 0.1)
                          : alpha(theme.palette.error.main, 0.1),
                      color: row.kind === "Asset" ? "success.main" : "error.main",
                    }}
                  >
                    {row.kind === "Asset" ? (
                      <SavingsRounded fontSize="small" />
                    ) : (
                      <TrendingDownRounded fontSize="small" />
                    )}
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={700}>
                      {row.group}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {row.detail}
                    </Typography>
                  </Box>
                  <Box sx={{ textAlign: "right" }}>
                    <Typography variant="body2" fontWeight={700}>
                      <Money value={row.amount} currency={row.currency} />
                    </Typography>
                    <Typography
                      variant="caption"
                      color={row.change >= 0 ? "success.main" : "error.main"}
                    >
                      {row.change >= 0 ? "+" : ""}
                      {row.change}%
                    </Typography>
                  </Box>
                </Stack>
              ))}
            </Box>
          ) : (
            <Box sx={{ mt: 4 }}>
              <EmptyState
                icon={<SavingsRounded />}
                title="No composition yet"
                description="Connect an account or add a valued asset to build a wealth snapshot."
                actionLabel="Add an asset"
                onAction={openCreateAsset}
              />
            </Box>
          )}
        </CardContent>
      </Card>
      <Box>
        <SectionHeader
          title="Valued assets"
          action={
            <Button startIcon={<AddRounded />} onClick={openCreateAsset}>
              Add asset
            </Button>
          }
        />
        {assetsQuery.isPending ? (
          <Box sx={{ mt: 4 }}>
            <LoadingCard rows={4} />
          </Box>
        ) : assetsQuery.isError ? (
          <Box sx={{ mt: 4 }}>
            <ErrorState
              message="BetterWealth could not load your valued assets."
              onRetry={() => assetsQuery.refetch()}
            />
          </Box>
        ) : assetsList.length ? (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", md: "repeat(2, 1fr)" },
              gap: 4,
              mt: 4,
            }}
          >
            {assetsList.map((asset) => {
              const freshness = assetFreshness(asset.valuedAt);
              return (
                <Card key={asset.id}>
                  <CardContent sx={{ p: 5 }}>
                    <Stack
                      direction="row"
                      justifyContent="space-between"
                      alignItems="flex-start"
                      gap={3}
                    >
                      <Box
                        sx={{
                          width: 46,
                          height: 46,
                          flex: "0 0 auto",
                          display: "grid",
                          placeItems: "center",
                          borderRadius: 1,
                          bgcolor: (theme) =>
                            alpha(
                              asset.type === "property"
                                ? theme.palette.secondary.main
                                : theme.palette.info.main,
                              0.1,
                            ),
                          color: asset.type === "property" ? "secondary.main" : "info.main",
                        }}
                      >
                        {assetIcon(asset)}
                      </Box>
                      <StatusChip
                        label={`${asset.source} · ${freshness.label}`}
                        tone={freshness.tone}
                      />
                    </Stack>
                    <Typography
                      variant="overline"
                      color="text.secondary"
                      sx={{ display: "block", mt: 4 }}
                    >
                      {asset.type} · {asset.liquidityClass}
                    </Typography>
                    <Typography variant="h6" sx={{ mt: 0.25 }}>
                      {asset.name}
                    </Typography>
                    <Typography variant="h5" sx={{ mt: 1 }}>
                      <Money
                        value={minorToMajor(asset.value.minorUnits, asset.value.currency)}
                        currency={asset.value.currency}
                      />
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                      Valued {new Date(asset.valuedAt).toLocaleDateString()} · {asset.confidence}{" "}
                      confidence{asset.relatedLiabilityId ? " · linked debt" : " · no linked debt"}
                    </Typography>
                    <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 3 }}>
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<UpdateRounded />}
                        onClick={() => openValuation(asset)}
                      >
                        Update value
                      </Button>
                      <Button
                        size="small"
                        color="inherit"
                        startIcon={<EditRounded />}
                        onClick={() => openEditAsset(asset)}
                      >
                        Edit details
                      </Button>
                    </Stack>
                  </CardContent>
                </Card>
              );
            })}
          </Box>
        ) : (
          <Box sx={{ mt: 4 }}>
            <EmptyState
              icon={<HomeRounded />}
              title="No valued assets yet"
              description="Add a home, vehicle, business, or collectible with a dated value to track it in your net worth."
              actionLabel="Add your first asset"
              onAction={openCreateAsset}
            />
          </Box>
        )}
      </Box>
      <AssetEditorDialog
        open={assetDialogOpen}
        editing={Boolean(editingAsset)}
        draft={assetDraft}
        setDraft={setAssetDraft}
        saving={createAsset.isPending || updateAsset.isPending}
        deleting={deleteAsset.isPending}
        error={mutationError instanceof Error ? mutationError.message : null}
        onClose={() => {
          setAssetDialogOpen(false);
          setEditingAsset(null);
        }}
        onSave={() => {
          if (demo) {
            setAssetDialogOpen(false);
            return;
          }
          if (editingAsset) updateAsset.mutate();
          else createAsset.mutate();
        }}
        {...(editingAsset
          ? {
              onDelete: () => {
                if (demo) {
                  setAssetDialogOpen(false);
                  return;
                }
                deleteAsset.mutate();
              },
            }
          : {})}
      />
      <ValuationDialog
        open={valuationOpen}
        assets={assetsList}
        selectedId={valuationAssetId}
        setSelectedId={(id) => {
          setValuationAssetId(id);
          const asset = assetsList.find((candidate) => candidate.id === id);
          setValuationAmount(
            asset ? String(minorToMajor(asset.value.minorUnits, asset.value.currency)) : "",
          );
          setValuationConfidence(asset?.confidence ?? "medium");
        }}
        amount={valuationAmount}
        setAmount={setValuationAmount}
        valuedOn={valuationDate}
        setValuedOn={setValuationDate}
        source={valuationSource}
        setSource={setValuationSource}
        reference={valuationReference}
        setReference={setValuationReference}
        confidence={valuationConfidence}
        setConfidence={setValuationConfidence}
        history={valuationsQuery.data?.data ?? []}
        historyLoading={valuationsQuery.isPending && Boolean(valuationAssetId)}
        saving={createValuation.isPending}
        error={
          createValuation.error instanceof Error
            ? createValuation.error.message
            : valuationsQuery.error instanceof Error
              ? valuationsQuery.error.message
              : null
        }
        onClose={() => setValuationOpen(false)}
        onSave={() => {
          if (demo) {
            setValuationOpen(false);
            return;
          }
          createValuation.mutate();
        }}
        onCreateAsset={() => {
          setValuationOpen(false);
          openCreateAsset();
        }}
      />
    </Stack>
  );
}

type GoalStatus = "active" | "paused" | "completed" | "cancelled";
type GoalLiquidity = "cash" | "liquid" | "investable" | "any";

// Every optional record field the goals page reads is part of ApiGoal already.
type GoalRecord = ApiGoal;

function minorUnits(value: ApiGoal["target"]): bigint {
  return BigInt(value.minorUnits);
}

function moneyValue(value: ApiGoal["target"]): number {
  return minorToMajor(value.minorUnits, value.currency);
}

function formatMinor(value: bigint, currency = "USD") {
  return formatMoneyExact(value, currency);
}

function monthLabel(value: string | null) {
  if (!value) return "No date yet";
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return "No date yet";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function dateLabel(value: string | null | undefined) {
  if (!value) return "No deadline";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value.slice(0, 10)}T12:00:00.000Z`));
}

function minorToInput(value: ApiGoal["target"]) {
  const amount = minorUnits(value);
  const whole = amount / 100n;
  const cents = amount % 100n;
  return cents === 0n ? whole.toString() : `${whole}.${cents.toString().padStart(2, "0")}`;
}

function typeLabel(type: ApiGoal["type"]) {
  const labels: Record<ApiGoal["type"], string> = {
    emergency_fund: "Cash resilience",
    purchase: "Comfortable purchase",
    debt_payoff: "Debt payoff",
    investment: "Investment milestone",
    custom: "Custom goal",
  };
  return labels[type];
}

function goalIcon(type: ApiGoal["type"]) {
  if (type === "emergency_fund") return <ShieldRounded />;
  if (type === "purchase") return <ShoppingBagRounded />;
  if (type === "debt_payoff") return <TrendingDownRounded />;
  return <TrendingUpRounded />;
}

function toGoalItem(goal: GoalRecord, startMonth = new Date().toISOString().slice(0, 7)) {
  const pace = deriveGoalPace({
    startMonth,
    currentAmount: { minorUnits: minorUnits(goal.funded), currency: goal.funded.currency },
    targetAmount: { minorUnits: minorUnits(goal.target), currency: goal.target.currency },
    monthlyContribution: {
      minorUnits: minorUnits(goal.monthlyContribution),
      currency: goal.monthlyContribution.currency,
    },
    targetMonth: goal.targetDate?.slice(0, 7) ?? null,
  });
  const status: GoalStatus =
    minorUnits(goal.funded) >= minorUnits(goal.target)
      ? "completed"
      : (goal.status ?? (goal.paused ? "paused" : "active"));
  return {
    record: goal,
    id: goal.id,
    name: goal.name,
    type: typeLabel(goal.type),
    funded: moneyValue(goal.funded),
    target: moneyValue(goal.target),
    monthly: moneyValue(goal.monthlyContribution),
    remaining: minorToMajor(pace.remainingAmount.minorUnits, pace.remainingAmount.currency),
    remainingMinor: pace.remainingAmount.minorUnits,
    requiredMonthlyMinor: pace.requiredMonthlyContribution?.minorUnits ?? null,
    shortfallMinor: pace.monthlyShortfall.minorUnits,
    projectedMonth: pace.projectedMonth,
    projectedLabel: monthLabel(pace.projectedMonth),
    monthsToGoal: pace.monthsToGoal,
    targetDate: goal.targetDate ?? null,
    onTrack: pace.onTrack,
    paceRatio: pace.paceRatio,
    status,
  };
}

type GoalItem = ReturnType<typeof toGoalItem>;

function goalStatus(goal: GoalItem): {
  label: string;
  tone: "positive" | "warning" | "risk" | "info" | "neutral";
} {
  if (goal.status === "completed") return { label: "Funded", tone: "positive" };
  if (goal.status === "paused") return { label: "Paused", tone: "neutral" };
  if (goal.onTrack === false) return { label: "Pace needed", tone: "risk" };
  if (goal.onTrack === true) return { label: "On pace", tone: "positive" };
  if (goal.monthly <= 0) return { label: "Needs a pace", tone: "warning" };
  return { label: "Funding", tone: "info" };
}

export function ComfortablePurchaseSummary({
  plan,
  fundingProjectedLabel,
}: {
  plan: ComfortablePurchasePlan;
  fundingProjectedLabel: string;
}) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const status =
    plan.status === "comfortable"
      ? ({ label: "Guardrails clear", tone: "positive" } as const)
      : plan.status === "not_comfortable"
        ? ({ label: "Guardrails blocked", tone: "risk" } as const)
        : ({ label: "Needs inputs", tone: "warning" } as const);
  const title =
    plan.status === "comfortable"
      ? plan.comfortableMonth === currentMonth
        ? "Modeled guardrails clear now"
        : `Modeled guardrails clear in ${monthLabel(plan.comfortableMonth)}`
      : plan.status === "not_comfortable"
        ? "No comfortable date in the 10-year window"
        : "Not enough data to estimate a comfortable date";
  const buffer = plan.inputs.protectedMinimumBuffer;
  const bills = plan.inputs.requiredMonthlyBills;
  const wealthTarget = plan.inputs.targetLiquidNetWorth;
  const verifiedSavings = plan.inputs.verifiedPurchaseSavings;
  const unreserved = plan.inputs.unreservedLiquidity;
  const monthlySurplus = plan.inputs.monthlySurplus;
  const projectedAtTarget = plan.inputs.projectedLiquidNetWorthAtTarget;
  const surplusSource =
    plan.inputs.monthlySurplusSource === "explicit_budget"
      ? "current budget"
      : plan.inputs.monthlySurplusSource === "observed_90_day"
        ? "90-day cash-flow history"
        : "not available";
  const modeledAmounts = [
    {
      label: "Verified purchase savings",
      value: verifiedSavings ? (
        <Money
          value={minorToMajor(verifiedSavings.minorUnits, verifiedSavings.currency)}
          currency={verifiedSavings.currency}
        />
      ) : (
        "—"
      ),
    },
    {
      label: "Unreserved cash",
      value: unreserved ? (
        <Money
          value={minorToMajor(unreserved.minorUnits, unreserved.currency)}
          currency={unreserved.currency}
        />
      ) : (
        "—"
      ),
    },
    {
      label: "Protected buffer",
      value: buffer ? (
        <Money
          value={minorToMajor(buffer.minorUnits, buffer.currency)}
          currency={buffer.currency}
        />
      ) : (
        "—"
      ),
    },
    {
      label: "Required bills / month",
      value: bills ? (
        <Money value={minorToMajor(bills.minorUnits, bills.currency)} currency={bills.currency} />
      ) : (
        "—"
      ),
    },
    {
      label: "Modeled monthly surplus",
      value: monthlySurplus ? (
        <>
          <Money
            value={minorToMajor(monthlySurplus.minorUnits, monthlySurplus.currency)}
            currency={monthlySurplus.currency}
          />{" "}
          · {surplusSource}
        </>
      ) : (
        "—"
      ),
    },
    {
      label: "Liquid wealth target",
      value:
        wealthTarget && plan.inputs.targetWealthDate ? (
          <>
            <Money
              value={minorToMajor(wealthTarget.minorUnits, wealthTarget.currency)}
              currency={wealthTarget.currency}
            />{" "}
            by {monthLabel(plan.inputs.targetWealthDate.slice(0, 7))}
          </>
        ) : (
          "—"
        ),
    },
    {
      label: "Projected liquid wealth at target month",
      value: projectedAtTarget ? (
        <Money
          value={minorToMajor(projectedAtTarget.minorUnits, projectedAtTarget.currency)}
          currency={projectedAtTarget.currency}
        />
      ) : (
        "—"
      ),
    },
  ];

  return (
    <Box
      sx={{
        mt: 3,
        p: 3,
        borderRadius: 1,
        border: "1px solid",
        borderColor:
          plan.status === "comfortable"
            ? "success.light"
            : plan.status === "not_comfortable"
              ? "error.light"
              : "warning.light",
        bgcolor:
          plan.status === "comfortable"
            ? (theme) => alpha(theme.palette.success.main, 0.055)
            : plan.status === "not_comfortable"
              ? (theme) => alpha(theme.palette.error.main, 0.045)
              : (theme) => alpha(theme.palette.warning.main, 0.05),
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
        <Typography variant="caption" color="text.secondary" fontWeight={700}>
          Comfortable-to-buy check
        </Typography>
        <StatusChip label={status.label} tone={status.tone} />
      </Stack>
      <Typography variant="body2" fontWeight={700} sx={{ mt: 1 }}>
        {title}
      </Typography>
      {plan.status === "incomplete" ? (
        <Stack component="ul" gap={0.75} sx={{ pl: 2.5, mt: 1.5, mb: 0 }}>
          {(plan.missingInputs.length
            ? plan.missingInputs
            : ["Complete the planning inputs to calculate this guardrail."]
          ).map((item) => (
            <Typography key={item} component="li" variant="caption" color="text.secondary">
              {item}
            </Typography>
          ))}
        </Stack>
      ) : (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
            {plan.status === "comfortable"
              ? "Every modeled guardrail clears in this month."
              : "These guardrails still fail in the modeled window:"}
          </Typography>
          {plan.limitingConstraints.length ? (
            <Stack component="ul" gap={1} sx={{ pl: 2.5, mt: 1.25, mb: 0 }}>
              {plan.limitingConstraints.map((constraint) => (
                <Typography
                  key={constraint.code}
                  component="li"
                  variant="caption"
                  color="text.secondary"
                >
                  <strong>{constraint.label}:</strong> {constraint.detail}
                </Typography>
              ))}
            </Stack>
          ) : null}
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" },
              gap: 1,
              mt: 2,
            }}
          >
            {modeledAmounts.map((item) => (
              <Box key={item.label}>
                <Typography variant="caption" color="text.secondary">
                  {item.label}
                </Typography>
                <Typography variant="caption" fontWeight={700} sx={{ display: "block" }}>
                  {item.value}
                </Typography>
              </Box>
            ))}
          </Box>
        </>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
        Funding projection: {fundingProjectedLabel}.
      </Typography>
      {plan.assumptions.length ? (
        <Box sx={{ mt: 1.5 }}>
          <Typography variant="caption" color="text.secondary" fontWeight={700}>
            Model assumptions
          </Typography>
          <Stack component="ul" gap={0.75} sx={{ pl: 2.5, mt: 0.75, mb: 0 }}>
            {plan.assumptions.map((assumption) => (
              <Typography key={assumption} component="li" variant="caption" color="text.secondary">
                {assumption}
              </Typography>
            ))}
          </Stack>
        </Box>
      ) : null}
    </Box>
  );
}

function GoalCard({
  goal,
  busy,
  readOnly,
  onContribute,
  onEdit,
  onPause,
  onWhatIf,
}: {
  goal: GoalItem;
  busy: boolean;
  readOnly: boolean;
  onContribute: () => void;
  onEdit: () => void;
  onPause: () => void;
  onWhatIf: () => void;
}) {
  const progress = goal.target <= 0 ? 0 : Math.min(100, (goal.funded / goal.target) * 100);
  const status = goalStatus(goal);
  return (
    <Card>
      <CardContent sx={{ p: { xs: 4, sm: 5 } }}>
        <Stack direction="row" justifyContent="space-between" gap={3}>
          <Box
            sx={{
              width: 44,
              height: 44,
              borderRadius: 1,
              bgcolor: "action.hover",
              color: "text.secondary",
              display: "grid",
              placeItems: "center",
            }}
          >
            {goalIcon(goal.record.type)}
          </Box>
          <Stack direction="row" alignItems="center" gap={0.5}>
            <StatusChip label={status.label} tone={status.tone} />
            <Tooltip title="Edit goal">
              <span>
                <IconButton aria-label={`Edit ${goal.name}`} size="small" onClick={onEdit}>
                  <EditRounded fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 4 }}>
          {goal.type}
        </Typography>
        <Typography variant="h6" sx={{ mt: 0.5 }}>
          {goal.name}
        </Typography>
        <Stack direction="row" alignItems="baseline" justifyContent="space-between" sx={{ mt: 4 }}>
          <Typography variant="h5">
            <Money value={goal.funded} currency={goal.record.funded.currency} />
          </Typography>
          <Typography variant="caption" color="text.secondary">
            of <Money value={goal.target} currency={goal.record.target.currency} />
          </Typography>
        </Stack>
        <ProgressMeter
          value={progress}
          label={`${goal.name} ${Math.round(progress)} percent funded`}
        />
        <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3, mt: 4 }}>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Monthly pace
            </Typography>
            <Typography variant="body2" fontWeight={700}>
              <Money value={goal.monthly} currency={goal.record.monthlyContribution.currency} />
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Projected funding
            </Typography>
            <Typography variant="body2" fontWeight={700}>
              {goal.status === "completed" ? "Complete" : goal.projectedLabel}
            </Typography>
          </Box>
        </Box>
        {goal.targetDate ? (
          <Typography
            variant="caption"
            color={goal.onTrack === false ? "error.main" : "text.secondary"}
            sx={{ display: "block", mt: 2 }}
          >
            {goal.onTrack === false
              ? `${formatMinor(goal.remainingMinor, goal.record.target.currency)} remains; add ${formatMinor(goal.requiredMonthlyMinor ?? BigInt(goal.record.monthlyContribution.minorUnits), goal.record.target.currency)}/mo to target ${dateLabel(goal.targetDate)}.`
              : `Target ${dateLabel(goal.targetDate)}${goal.status === "completed" ? " reached" : " is covered by this pace"}.`}
          </Typography>
        ) : null}
        {goal.record.type === "purchase" && goal.record.comfortablePurchase ? (
          <ComfortablePurchaseSummary
            plan={goal.record.comfortablePurchase}
            fundingProjectedLabel={
              goal.status === "completed" ? "already fully funded" : goal.projectedLabel
            }
          />
        ) : null}
        <Divider sx={{ my: 4 }} />
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={2}>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Remaining
            </Typography>
            <Typography variant="body2" fontWeight={700}>
              <Money value={goal.remaining} currency={goal.record.target.currency} />
            </Typography>
          </Box>
          <Stack direction="row" flexWrap="wrap" gap={1}>
            {goal.status !== "completed" ? (
              <Button
                size="small"
                startIcon={<PaymentsRounded />}
                disabled={busy}
                onClick={onContribute}
              >
                Fund
              </Button>
            ) : null}
            <Button size="small" onClick={onWhatIf} endIcon={<ArrowForwardRounded />}>
              What if
            </Button>
            {goal.status !== "completed" ? (
              <Tooltip title={goal.status === "paused" ? "Resume goal" : "Pause goal"}>
                <span>
                  <IconButton
                    size="small"
                    aria-label={`${goal.status === "paused" ? "Resume" : "Pause"} ${goal.name}`}
                    disabled={busy || readOnly}
                    onClick={onPause}
                  >
                    {goal.status === "paused" ? <PlayArrowRounded /> : <PauseRounded />}
                  </IconButton>
                </span>
              </Tooltip>
            ) : null}
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

type GoalDraft = {
  name: string;
  type: ApiGoal["type"];
  target: string;
  funded: string;
  monthly: string;
  targetDate: string;
  fundingAccountId: string;
  linkedDebtAccountId: string;
  liquidityConstraint: GoalLiquidity;
  paused: boolean;
};

function emptyGoalDraft(): GoalDraft {
  return {
    name: "",
    type: "purchase",
    target: "",
    funded: "0",
    monthly: "",
    targetDate: "",
    fundingAccountId: "",
    linkedDebtAccountId: "",
    liquidityConstraint: "liquid",
    paused: false,
  };
}

function draftForGoal(goal: GoalRecord): GoalDraft {
  return {
    name: goal.name,
    type: goal.type,
    target: minorToInput(goal.target),
    funded: minorToInput(goal.funded),
    monthly: minorToInput(goal.monthlyContribution),
    targetDate: goal.targetDate?.slice(0, 10) ?? "",
    fundingAccountId: goal.fundingAccountId ?? "",
    linkedDebtAccountId: goal.linkedDebtAccountId ?? "",
    liquidityConstraint: goal.liquidityConstraint ?? "liquid",
    paused: goal.status === "paused" || goal.paused,
  };
}

function GoalEditorDialog({
  open,
  editing,
  draft,
  setDraft,
  accounts,
  readOnly,
  saving,
  archiving,
  error,
  onClose,
  onSave,
  onArchive,
}: {
  open: boolean;
  editing: boolean;
  draft: GoalDraft;
  setDraft: (draft: GoalDraft) => void;
  accounts: ApiAccount[];
  readOnly: boolean;
  saving: boolean;
  archiving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: () => void;
  onArchive?: () => void;
}) {
  const targetMinor = dollarsToMinor(draft.target);
  const fundedMinor = dollarsToMinor(draft.funded);
  const monthlyMinor = draft.monthly.trim() ? dollarsToMinor(draft.monthly) : "0";
  const valid =
    draft.name.trim().length > 0 &&
    targetMinor !== null &&
    BigInt(targetMinor) > 0n &&
    fundedMinor !== null &&
    BigInt(fundedMinor) >= 0n &&
    BigInt(fundedMinor) <= BigInt(targetMinor) &&
    monthlyMinor !== null &&
    BigInt(monthlyMinor) >= 0n;
  const debtAccounts = accounts.filter(
    (account) => account.group === "credit" || account.group === "loan",
  );
  return (
    <Dialog open={open} onClose={saving || archiving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{editing ? "Edit goal" : "Create a goal"}</DialogTitle>
      <DialogContent>
        <Stack gap={3} sx={{ mt: 1 }}>
          <TextField
            autoFocus
            required
            label="Goal name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <FormControl size="small">
            <InputLabel id="goal-type-label">Goal type</InputLabel>
            <Select
              labelId="goal-type-label"
              label="Goal type"
              value={draft.type}
              onChange={(event) => {
                const type = event.target.value as ApiGoal["type"];
                setDraft({
                  ...draft,
                  type,
                  linkedDebtAccountId: type === "debt_payoff" ? draft.linkedDebtAccountId : "",
                  liquidityConstraint:
                    type === "investment" ? "investable" : draft.liquidityConstraint,
                });
              }}
            >
              <MenuItem value="emergency_fund">Emergency fund</MenuItem>
              <MenuItem value="purchase">Purchase or trip</MenuItem>
              <MenuItem value="debt_payoff">Debt payoff</MenuItem>
              <MenuItem value="investment">Investment milestone</MenuItem>
              <MenuItem value="custom">Custom</MenuItem>
            </Select>
          </FormControl>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 3 }}>
            <TextField
              required
              label="Target amount"
              value={draft.target}
              onChange={(event) => setDraft({ ...draft, target: event.target.value })}
              inputProps={{ inputMode: "decimal" }}
              InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
            />
            {editing ? (
              <Box sx={{ px: 3, py: 2, borderRadius: 1, bgcolor: "action.hover" }}>
                <Typography variant="caption" color="text.secondary">
                  Already funded
                </Typography>
                <Typography variant="body2" fontWeight={700}>
                  {formatMinor(BigInt(fundedMinor ?? "0"))}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Use “Fund” to change it.
                </Typography>
              </Box>
            ) : (
              <TextField
                label="Already saved"
                value={draft.funded}
                onChange={(event) => setDraft({ ...draft, funded: event.target.value })}
                inputProps={{ inputMode: "decimal" }}
                InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
              />
            )}
          </Box>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 3 }}>
            <TextField
              label="Monthly contribution"
              value={draft.monthly}
              onChange={(event) => setDraft({ ...draft, monthly: event.target.value })}
              inputProps={{ inputMode: "decimal" }}
              InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
              helperText="Used for the projected date"
            />
            <TextField
              label="Target date"
              type="date"
              value={draft.targetDate}
              onChange={(event) => setDraft({ ...draft, targetDate: event.target.value })}
              slotProps={{ inputLabel: { shrink: true } }}
              helperText="Optional pace check"
            />
          </Box>
          <FormControl size="small">
            <InputLabel id="goal-funding-account-label">Funding account</InputLabel>
            <Select
              labelId="goal-funding-account-label"
              label="Funding account"
              value={draft.fundingAccountId}
              onChange={(event) => setDraft({ ...draft, fundingAccountId: event.target.value })}
            >
              <MenuItem value="">No linked account</MenuItem>
              {accounts.map((account) => (
                <MenuItem key={account.id} value={account.id}>
                  {account.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {draft.type === "debt_payoff" ? (
            <FormControl size="small">
              <InputLabel id="goal-debt-account-label">Debt account</InputLabel>
              <Select
                labelId="goal-debt-account-label"
                label="Debt account"
                value={draft.linkedDebtAccountId}
                onChange={(event) =>
                  setDraft({ ...draft, linkedDebtAccountId: event.target.value })
                }
              >
                <MenuItem value="">No linked debt</MenuItem>
                {debtAccounts.map((account) => (
                  <MenuItem key={account.id} value={account.id}>
                    {account.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ) : null}
          <FormControl size="small">
            <InputLabel id="goal-liquidity-label">Funding constraint</InputLabel>
            <Select
              labelId="goal-liquidity-label"
              label="Funding constraint"
              value={draft.liquidityConstraint}
              onChange={(event) =>
                setDraft({ ...draft, liquidityConstraint: event.target.value as GoalLiquidity })
              }
            >
              <MenuItem value="cash">Cash only</MenuItem>
              <MenuItem value="liquid">Liquid accounts</MenuItem>
              <MenuItem value="investable">Investable assets</MenuItem>
              <MenuItem value="any">Any net-worth asset</MenuItem>
            </Select>
          </FormControl>
          <FormControlLabel
            control={
              <Switch
                checked={draft.paused}
                onChange={(event) => setDraft({ ...draft, paused: event.target.checked })}
              />
            }
            label="Pause monthly funding"
          />
          {readOnly ? (
            <Alert severity="info">Demo goals are read-only. Sign in to save a plan.</Alert>
          ) : null}
        </Stack>
      </DialogContent>
      {error ? (
        <Alert severity="error" sx={{ mx: 3 }}>
          {error}
        </Alert>
      ) : null}
      <DialogActions sx={{ justifyContent: editing ? "space-between" : "flex-end" }}>
        {editing && onArchive ? (
          <Button
            color="error"
            startIcon={<ArchiveRounded />}
            disabled={saving || archiving || readOnly}
            onClick={onArchive}
          >
            {archiving ? "Archiving…" : "Archive"}
          </Button>
        ) : null}
        <Stack direction="row" gap={1}>
          <Button color="inherit" disabled={saving || archiving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={!valid || saving || archiving || readOnly}
            onClick={onSave}
          >
            {saving ? "Saving…" : editing ? "Save goal" : "Create goal"}
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}

function ContributionDialog({
  goal,
  amount,
  setAmount,
  contributedOn,
  setContributedOn,
  note,
  setNote,
  history,
  historyLoading,
  readOnly,
  saving,
  error,
  onClose,
  onSave,
}: {
  goal: GoalItem | null;
  amount: string;
  setAmount: (value: string) => void;
  contributedOn: string;
  setContributedOn: (value: string) => void;
  note: string;
  setNote: (value: string) => void;
  history: ApiGoalContribution[];
  historyLoading: boolean;
  readOnly: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: () => void;
}) {
  const amountMinor = dollarsToMinor(amount);
  const remainingMinor = goal
    ? BigInt(goal.record.target.minorUnits) - BigInt(goal.record.funded.minorUnits)
    : 0n;
  const valid =
    Boolean(goal) &&
    amountMinor !== null &&
    BigInt(amountMinor) > 0n &&
    BigInt(amountMinor) <= remainingMinor;
  return (
    <Dialog open={Boolean(goal)} onClose={saving ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Fund {goal?.name}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">
          This updates the goal plan only; it does not move money between accounts.
        </Typography>
        <Stack gap={3} sx={{ mt: 4 }}>
          <TextField
            autoFocus
            required
            label="Contribution"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputProps={{ inputMode: "decimal" }}
            InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
            helperText={
              goal
                ? `${formatMinor(remainingMinor, goal.record.target.currency)} remains`
                : undefined
            }
            error={amountMinor !== null && BigInt(amountMinor) > remainingMinor}
          />
          <TextField
            label="Contribution date"
            type="date"
            value={contributedOn}
            onChange={(event) => setContributedOn(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            label="Note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            multiline
            minRows={2}
            placeholder="Paycheck allocation"
          />
          <Box sx={{ p: 3, borderRadius: 1, bgcolor: "action.hover" }}>
            <Typography variant="caption" color="text.secondary">
              Recent funding
            </Typography>
            {historyLoading ? (
              <Typography variant="body2" sx={{ mt: 1 }}>
                Loading contributions…
              </Typography>
            ) : history.length ? (
              <Stack gap={1.25} sx={{ mt: 1.5 }}>
                {history.slice(0, 3).map((contribution) => (
                  <Stack
                    key={contribution.id}
                    direction="row"
                    justifyContent="space-between"
                    gap={2}
                  >
                    <Typography variant="caption" color="text.secondary">
                      {dateLabel(contribution.contributedOn)}
                      {contribution.note ? ` · ${contribution.note}` : ""}
                    </Typography>
                    <Typography variant="caption" fontWeight={700}>
                      {formatMinor(
                        BigInt(contribution.amount.minorUnits),
                        contribution.amount.currency,
                      )}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            ) : (
              <Typography variant="body2" sx={{ mt: 1 }}>
                No recorded contributions yet.
              </Typography>
            )}
          </Box>
          {readOnly ? (
            <Alert severity="info">Demo goals are read-only. Sign in to record funding.</Alert>
          ) : null}
        </Stack>
      </DialogContent>
      {error ? (
        <Alert severity="error" sx={{ mx: 3 }}>
          {error}
        </Alert>
      ) : null}
      <DialogActions>
        <Button color="inherit" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!valid || saving || readOnly} onClick={onSave}>
          {saving ? "Recording…" : "Record contribution"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function WhatIfDialog({
  goal,
  target,
  setTarget,
  monthly,
  setMonthly,
  readOnly,
  saving,
  error,
  onClose,
  onSave,
}: {
  goal: GoalItem | null;
  target: string;
  setTarget: (value: string) => void;
  monthly: string;
  setMonthly: (value: string) => void;
  readOnly: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: () => void;
}) {
  const targetMinor = dollarsToMinor(target);
  const monthlyMinor = dollarsToMinor(monthly);
  const fundedMinor = goal ? BigInt(goal.record.funded.minorUnits) : 0n;
  const valid =
    Boolean(goal) &&
    targetMinor !== null &&
    BigInt(targetMinor) >= fundedMinor &&
    BigInt(targetMinor) > 0n &&
    monthlyMinor !== null &&
    BigInt(monthlyMinor) >= 0n;
  const scenario =
    goal && valid && targetMinor !== null && monthlyMinor !== null
      ? toGoalItem({
          ...goal.record,
          target: { ...goal.record.target, minorUnits: targetMinor },
          monthlyContribution: { ...goal.record.monthlyContribution, minorUnits: monthlyMinor },
        })
      : null;
  const monthsChanged =
    scenario?.monthsToGoal !== null &&
    goal?.monthsToGoal !== null &&
    scenario?.monthsToGoal !== undefined &&
    goal?.monthsToGoal !== undefined
      ? goal.monthsToGoal - scenario.monthsToGoal
      : null;
  return (
    <Dialog open={Boolean(goal)} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>What if: {goal?.name}</DialogTitle>
      <DialogContent>
        <Typography color="text.secondary">
          Change the target or monthly pace to preview the projected funding date before saving.
        </Typography>
        <Box
          sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 3, mt: 4 }}
        >
          <TextField
            label="What-if target"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            inputProps={{ inputMode: "decimal" }}
            InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
          />
          <TextField
            label="What-if monthly pace"
            value={monthly}
            onChange={(event) => setMonthly(event.target.value)}
            inputProps={{ inputMode: "decimal" }}
            InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
          />
        </Box>
        {scenario ? (
          <Box sx={{ mt: 4, p: 4, borderRadius: 1, bgcolor: "action.hover" }}>
            <Stack direction="row" justifyContent="space-between" gap={3}>
              <Typography variant="body2">Projected funding date</Typography>
              <Typography variant="body2" fontWeight={700}>
                {scenario.projectedLabel}
              </Typography>
            </Stack>
            <Stack direction="row" justifyContent="space-between" gap={3} sx={{ mt: 2 }}>
              <Typography variant="body2">Change from current pace</Typography>
              <Typography
                variant="body2"
                fontWeight={700}
                color={
                  monthsChanged !== null && monthsChanged > 0 ? "success.main" : "text.primary"
                }
              >
                {monthsChanged === null
                  ? "Needs a non-zero pace"
                  : monthsChanged === 0
                    ? "Same month"
                    : monthsChanged > 0
                      ? `${monthsChanged} month${monthsChanged === 1 ? "" : "s"} sooner`
                      : `${Math.abs(monthsChanged)} month${monthsChanged === -1 ? "" : "s"} later`}
              </Typography>
            </Stack>
            <Stack direction="row" justifyContent="space-between" gap={3} sx={{ mt: 2 }}>
              <Typography variant="body2">Monthly cash commitment</Typography>
              <Typography variant="body2" fontWeight={700}>
                {formatMinor(
                  BigInt(scenario.record.monthlyContribution.minorUnits),
                  scenario.record.monthlyContribution.currency,
                )}
              </Typography>
            </Stack>
            {scenario.targetDate ? (
              <Stack direction="row" justifyContent="space-between" gap={3} sx={{ mt: 2 }}>
                <Typography variant="body2">Target-date pace</Typography>
                <Typography
                  variant="body2"
                  fontWeight={700}
                  color={scenario.onTrack ? "success.main" : "error.main"}
                >
                  {scenario.onTrack
                    ? "Covered"
                    : `${formatMinor(scenario.shortfallMinor, goal?.record.target.currency)}/mo short`}
                </Typography>
              </Stack>
            ) : null}
          </Box>
        ) : (
          <Alert severity="warning" sx={{ mt: 4 }}>
            Enter a target at least as large as current funding and a valid monthly amount.
          </Alert>
        )}
        <Alert severity="info" sx={{ mt: 4 }}>
          This view models goal funding only; market returns and debt interest are handled in the
          full forecast.
        </Alert>
      </DialogContent>
      {error ? (
        <Alert severity="error" sx={{ mx: 3 }}>
          {error}
        </Alert>
      ) : null}
      <DialogActions>
        <Button component={RouterLink} to="/forecast" color="inherit">
          Open full forecast
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button color="inherit" disabled={saving} onClick={onClose}>
          Close
        </Button>
        <Button variant="contained" disabled={!valid || saving || readOnly} onClick={onSave}>
          {saving ? "Saving…" : "Use this plan"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function GoalsPage() {
  const demo = isDemoMode();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<GoalItem | null>(null);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [goalDraft, setGoalDraft] = useState<GoalDraft>(emptyGoalDraft);
  const [contributionGoal, setContributionGoal] = useState<GoalItem | null>(null);
  const [contributionAmount, setContributionAmount] = useState("");
  const [contributionDate, setContributionDate] = useState(new Date().toISOString().slice(0, 10));
  const [contributionNote, setContributionNote] = useState("");
  const [whatIf, setWhatIf] = useState<GoalItem | null>(null);
  const [whatIfTarget, setWhatIfTarget] = useState("");
  const [whatIfMonthly, setWhatIfMonthly] = useState("");

  const goalsQuery = useQuery({
    queryKey: ["goals"],
    queryFn: async () => (await api.goals()) as CursorPage<GoalRecord>,
    ...(demo ? { initialData: demoApiGoals } : {}),
    enabled: !demo,
    retry: 1,
  });
  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: api.accounts,
    ...(demo ? { initialData: demoGoalAccounts } : {}),
    enabled: !demo,
    retry: 1,
  });
  const contributionsQuery = useQuery({
    queryKey: ["goal-contributions", contributionGoal?.id],
    queryFn: () => api.goalContributions(contributionGoal?.id ?? ""),
    enabled: !demo && Boolean(contributionGoal),
    retry: 1,
  });
  const goalItems: GoalItem[] = useMemo(
    () =>
      (goalsQuery.data?.data ?? [])
        .map((goal) => toGoalItem(goal))
        .sort(
          (left, right) =>
            left.record.priority - right.record.priority || left.name.localeCompare(right.name),
        ),
    [goalsQuery.data],
  );
  const visibleGoals = goalItems.filter((goal) => goal.status !== "cancelled");
  const activeGoals = visibleGoals.filter((goal) => goal.status === "active");
  const recommendedGoal = activeGoals.find((goal) => goal.remainingMinor > 0n) ?? null;

  useEffect(() => {
    if (searchParams.get("action") !== "add") return;
    setEditingGoal(null);
    setGoalDraft(emptyGoalDraft());
    setEditorOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("action");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["goals"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
    ]);
  };
  const createGoal = useMutation({
    mutationFn: () => {
      const target = dollarsToMinor(goalDraft.target);
      const funded = dollarsToMinor(goalDraft.funded);
      const monthly = dollarsToMinor(goalDraft.monthly || "0");
      if (!target || funded === null || monthly === null)
        throw new Error("Enter valid goal amounts with no more than two decimal places.");
      const priority = Math.max(0, ...goalItems.map((goal) => goal.record.priority)) + 1;
      return api.createGoal({
        name: goalDraft.name.trim(),
        type: goalDraft.type,
        target: { minorUnits: target, currency: "USD" },
        funded: { minorUnits: funded, currency: "USD" },
        monthlyContribution: { minorUnits: monthly, currency: "USD" },
        priority,
        paused: goalDraft.paused,
        ...(goalDraft.targetDate ? { targetDate: goalDraft.targetDate } : {}),
        ...(goalDraft.fundingAccountId ? { fundingAccountId: goalDraft.fundingAccountId } : {}),
        ...(goalDraft.type === "debt_payoff" && goalDraft.linkedDebtAccountId
          ? { linkedDebtAccountId: goalDraft.linkedDebtAccountId }
          : {}),
        liquidityConstraint: goalDraft.liquidityConstraint,
      });
    },
    onSuccess: async () => {
      setEditorOpen(false);
      setGoalDraft(emptyGoalDraft());
      await invalidate();
    },
  });
  const updateGoal = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ApiGoalPatch }) => api.updateGoal(id, patch),
    onSuccess: invalidate,
  });
  const archiveGoal = useMutation({
    mutationFn: (id: string) => api.archiveGoal(id),
    onSuccess: async () => {
      setArchiveConfirmOpen(false);
      setEditorOpen(false);
      setEditingGoal(null);
      await invalidate();
    },
  });
  const contribute = useMutation({
    mutationFn: ({ goalId, amount }: { goalId: string; amount: string }) =>
      api.contributeToGoal(goalId, {
        amount: { minorUnits: amount, currency: "USD" },
        source: "unassigned",
        contributedOn: contributionDate,
        ...(contributionNote.trim() ? { note: contributionNote.trim() } : {}),
      }),
    onSuccess: async () => {
      setContributionGoal(null);
      setContributionAmount("");
      setContributionNote("");
      await queryClient.invalidateQueries({ queryKey: ["goal-contributions"] });
      await invalidate();
    },
  });
  const reorderGoals = useMutation({
    mutationFn: async ({ id, direction }: { id: string; direction: -1 | 1 }) => {
      const ordered = visibleGoals.slice();
      const index = ordered.findIndex((goal) => goal.id === id);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= ordered.length) return;
      const [moved] = ordered.splice(index, 1);
      if (!moved) return;
      ordered.splice(destination, 0, moved);
      await api.reorderGoals(ordered.map((goal) => goal.id));
    },
    onSuccess: invalidate,
  });

  const openCreate = () => {
    setEditingGoal(null);
    setGoalDraft(emptyGoalDraft());
    setEditorOpen(true);
  };
  const openEdit = (goal: GoalItem) => {
    setEditingGoal(goal);
    setGoalDraft(draftForGoal(goal.record));
    setEditorOpen(true);
  };
  const openContribution = (goal: GoalItem) => {
    setContributionGoal(goal);
    const monthly = BigInt(goal.record.monthlyContribution.minorUnits);
    const suggested = monthly > 0n && monthly < goal.remainingMinor ? monthly : goal.remainingMinor;
    setContributionAmount(
      suggested > 0n
        ? minorToInput({ minorUnits: suggested.toString(), currency: goal.record.target.currency })
        : "",
    );
    setContributionDate(new Date().toISOString().slice(0, 10));
    setContributionNote("");
  };
  const openWhatIf = (goal: GoalItem) => {
    setWhatIf(goal);
    setWhatIfTarget(minorToInput(goal.record.target));
    setWhatIfMonthly(minorToInput(goal.record.monthlyContribution));
  };

  const mutationError =
    createGoal.error instanceof Error
      ? createGoal.error.message
      : updateGoal.error instanceof Error
        ? updateGoal.error.message
        : archiveGoal.error instanceof Error
          ? archiveGoal.error.message
          : null;

  if (goalsQuery.isPending)
    return (
      <Stack gap={4}>
        <PageHeader title="Goals" />
        <LoadingCard rows={6} />
      </Stack>
    );
  if (goalsQuery.isError)
    return (
      <Stack gap={4}>
        <PageHeader title="Goals" />
        <ErrorState
          message="BetterWealth could not load your goals."
          onRetry={() => goalsQuery.refetch()}
        />
      </Stack>
    );
  const totalFunded = visibleGoals.reduce(
    (sum, goal) => sum + BigInt(goal.record.funded.minorUnits),
    0n,
  );
  const monthlyCommitted = activeGoals.reduce(
    (sum, goal) => sum + BigInt(goal.record.monthlyContribution.minorUnits),
    0n,
  );
  const investmentMonthly = activeGoals
    .filter((goal) => goal.record.type === "investment")
    .reduce((sum, goal) => sum + BigInt(goal.record.monthlyContribution.minorUnits), 0n);
  const goalSummaryCurrency = visibleGoals[0]?.record.target.currency ?? "USD";
  const deadlineGoals = activeGoals.filter((goal) => goal.targetDate);
  const deadlineOnTrack = deadlineGoals.filter((goal) => goal.onTrack).length;
  const recommendation = !recommendedGoal
    ? null
    : recommendedGoal.shortfallMinor > 0n && recommendedGoal.requiredMonthlyMinor !== null
      ? {
          severity: "warning" as const,
          title: `${recommendedGoal.name} needs ${formatMinor(recommendedGoal.shortfallMinor, recommendedGoal.record.target.currency)} more each month`,
          detail: `A ${formatMinor(recommendedGoal.requiredMonthlyMinor ?? 0n, recommendedGoal.record.target.currency)} monthly pace reaches the ${dateLabel(recommendedGoal.targetDate)} target.`,
          action: "Use required pace",
          kind: "pace" as const,
        }
      : recommendedGoal.monthly <= 0
        ? {
            severity: "info" as const,
            title: `Give ${recommendedGoal.name} a monthly pace`,
            detail: `${formatMinor(recommendedGoal.remainingMinor, recommendedGoal.record.target.currency)} remains, so there is no projected date yet.`,
            action: "Set pace",
            kind: "edit" as const,
          }
        : {
            severity: "success" as const,
            title: `${recommendedGoal.name} is first in your funding order`,
            detail: `A ${formatMinor(BigInt(recommendedGoal.record.monthlyContribution.minorUnits), recommendedGoal.record.monthlyContribution.currency)} monthly pace keeps the projected date at ${recommendedGoal.projectedLabel}.`,
            action: "Record funding",
            kind: "fund" as const,
          };
  return (
    <Stack gap={5}>
      <PageHeader
        title="Goals"
        actions={
          <Button variant="contained" startIcon={<AddRounded />} onClick={openCreate}>
            New goal
          </Button>
        }
      />
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)", xl: "repeat(4, 1fr)" },
          gap: 3,
        }}
      >
        <MetricCard
          label="Already assigned"
          value={
            <Money
              value={minorToMajor(totalFunded, goalSummaryCurrency)}
              currency={goalSummaryCurrency}
            />
          }
          helper={`Across ${visibleGoals.length} visible goal${visibleGoals.length === 1 ? "" : "s"}`}
        />
        <MetricCard
          label="Monthly committed"
          value={
            <Money
              value={minorToMajor(monthlyCommitted, goalSummaryCurrency)}
              currency={goalSummaryCurrency}
            />
          }
          helper="Active goal commitments"
        />
        <MetricCard
          label="Investing each month"
          value={
            <Money
              value={minorToMajor(investmentMonthly, goalSummaryCurrency)}
              currency={goalSummaryCurrency}
            />
          }
          helper="Investment milestones only"
        />
        <MetricCard
          label="Deadlines on pace"
          value={`${deadlineOnTrack} / ${deadlineGoals.length}`}
          helper={
            deadlineGoals.length
              ? "Based on required monthly cents"
              : "Add a target date to measure pace"
          }
        />
      </Box>
      {recommendation ? (
        <Alert severity={recommendation.severity} icon={<CheckCircleRounded />}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            alignItems={{ xs: "flex-start", sm: "center" }}
            justifyContent="space-between"
            gap={{ xs: 1.5, sm: 3 }}
            sx={{ width: "100%" }}
          >
            <Typography variant="body2">
              <strong>Next move: {recommendation.title}.</strong> {recommendation.detail}
            </Typography>
            <Button
              color="inherit"
              size="small"
              sx={{ flexShrink: 0 }}
              disabled={demo || updateGoal.isPending || contribute.isPending}
              onClick={() => {
                if (!recommendedGoal) return;
                if (recommendation.kind === "edit") openEdit(recommendedGoal);
                if (recommendation.kind === "fund") openContribution(recommendedGoal);
                if (
                  recommendation.kind === "pace" &&
                  recommendedGoal.requiredMonthlyMinor !== null
                ) {
                  updateGoal.mutate({
                    id: recommendedGoal.id,
                    patch: {
                      monthlyContribution: {
                        minorUnits: recommendedGoal.requiredMonthlyMinor.toString(),
                        currency: recommendedGoal.record.monthlyContribution.currency,
                      },
                    },
                  });
                }
              }}
            >
              {recommendation.action}
            </Button>
          </Stack>
        </Alert>
      ) : visibleGoals.length ? (
        <Alert severity="success">Every visible goal is funded or paused.</Alert>
      ) : null}
      {contribute.error instanceof Error ? (
        <Alert severity="error">{contribute.error.message}</Alert>
      ) : null}
      {reorderGoals.error instanceof Error ? (
        <Alert severity="error">{reorderGoals.error.message}</Alert>
      ) : null}

      {visibleGoals.length ? (
        <Box
          sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(2, 1fr)" }, gap: 4 }}
        >
          {visibleGoals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              busy={updateGoal.isPending || contribute.isPending}
              readOnly={demo}
              onContribute={() => openContribution(goal)}
              onEdit={() => openEdit(goal)}
              onPause={() =>
                updateGoal.mutate({ id: goal.id, patch: { paused: goal.status !== "paused" } })
              }
              onWhatIf={() => openWhatIf(goal)}
            />
          ))}
        </Box>
      ) : (
        <EmptyState
          icon={<FlagRounded />}
          title="No active goals yet"
          description="Create an emergency fund, purchase, debt payoff, or investment goal to track your progress."
          actionLabel="Create a goal"
          onAction={openCreate}
        />
      )}

      {visibleGoals.length ? (
        <Card>
          <CardContent sx={{ p: { xs: 4, sm: 5 } }}>
            <SectionHeader title="Goal funding order" />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              New contributions fund the first active, unfinished goal in this order.
            </Typography>
            <Stack sx={{ mt: 4 }}>
              {visibleGoals.map((goal, index) => {
                const status = goalStatus(goal);
                return (
                  <Stack
                    key={goal.id}
                    direction="row"
                    alignItems="center"
                    gap={{ xs: 1.5, sm: 3 }}
                    sx={{
                      minHeight: 68,
                      borderBottom: index === visibleGoals.length - 1 ? 0 : "1px solid",
                      borderColor: "divider",
                    }}
                  >
                    <DragIndicatorRounded
                      sx={{ color: "text.disabled", display: { xs: "none", sm: "block" } }}
                    />
                    <Box
                      sx={{
                        width: 28,
                        height: 28,
                        flexShrink: 0,
                        borderRadius: "50%",
                        display: "grid",
                        placeItems: "center",
                        bgcolor:
                          index === 0 && goal.status === "active"
                            ? "secondary.main"
                            : "action.hover",
                        color:
                          index === 0 && goal.status === "active"
                            ? "secondary.contrastText"
                            : "text.secondary",
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      {index + 1}
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        variant="body2"
                        fontWeight={700}
                        sx={{ whiteSpace: { sm: "nowrap" } }}
                      >
                        {goal.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {formatMinor(
                          BigInt(goal.record.monthlyContribution.minorUnits),
                          goal.record.monthlyContribution.currency,
                        )}
                        /mo · {formatMinor(goal.remainingMinor, goal.record.target.currency)}{" "}
                        remaining
                      </Typography>
                    </Box>
                    <Box sx={{ display: { xs: "none", sm: "block" } }}>
                      <StatusChip label={status.label} tone={status.tone} />
                    </Box>
                    <Stack direction="row" gap={0}>
                      <IconButton
                        aria-label={`Move ${goal.name} up`}
                        size="small"
                        disabled={demo || index === 0 || reorderGoals.isPending}
                        onClick={() => reorderGoals.mutate({ id: goal.id, direction: -1 })}
                      >
                        <KeyboardArrowUpRounded />
                      </IconButton>
                      <IconButton
                        aria-label={`Move ${goal.name} down`}
                        size="small"
                        disabled={
                          demo || index === visibleGoals.length - 1 || reorderGoals.isPending
                        }
                        onClick={() => reorderGoals.mutate({ id: goal.id, direction: 1 })}
                      >
                        <KeyboardArrowDownRounded />
                      </IconButton>
                    </Stack>
                  </Stack>
                );
              })}
            </Stack>
          </CardContent>
        </Card>
      ) : null}

      <GoalEditorDialog
        open={editorOpen}
        editing={Boolean(editingGoal)}
        draft={goalDraft}
        setDraft={setGoalDraft}
        accounts={accountsQuery.data?.data ?? []}
        readOnly={demo}
        saving={createGoal.isPending || updateGoal.isPending}
        archiving={archiveGoal.isPending}
        error={mutationError}
        onClose={() => {
          setArchiveConfirmOpen(false);
          setEditorOpen(false);
          setEditingGoal(null);
        }}
        onSave={() => {
          if (!editingGoal) {
            createGoal.mutate();
            return;
          }
          const target = dollarsToMinor(goalDraft.target);
          const monthly = dollarsToMinor(goalDraft.monthly || "0");
          if (!target || monthly === null) return;
          updateGoal.mutate(
            {
              id: editingGoal.id,
              patch: {
                name: goalDraft.name.trim(),
                type: goalDraft.type,
                target: { minorUnits: target, currency: editingGoal.record.target.currency },
                monthlyContribution: {
                  minorUnits: monthly,
                  currency: editingGoal.record.target.currency,
                },
                paused: goalDraft.paused,
                targetDate: goalDraft.targetDate || null,
                fundingAccountId: goalDraft.fundingAccountId || null,
                linkedDebtAccountId:
                  goalDraft.type === "debt_payoff" ? goalDraft.linkedDebtAccountId || null : null,
                liquidityConstraint: goalDraft.liquidityConstraint,
              },
            },
            {
              onSuccess: () => {
                setEditorOpen(false);
                setEditingGoal(null);
              },
            },
          );
        }}
        {...(editingGoal ? { onArchive: () => setArchiveConfirmOpen(true) } : {})}
      />
      <Dialog
        open={archiveConfirmOpen && Boolean(editingGoal)}
        onClose={archiveGoal.isPending ? undefined : () => setArchiveConfirmOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>Archive {editingGoal?.name}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            The goal will be removed from your active plan and funding order. Its contribution
            history is kept.
          </Typography>
        </DialogContent>
        {archiveGoal.error instanceof Error ? (
          <Alert severity="error" sx={{ mx: 3 }}>
            {archiveGoal.error.message}
          </Alert>
        ) : null}
        <DialogActions>
          <Button
            color="inherit"
            disabled={archiveGoal.isPending}
            onClick={() => setArchiveConfirmOpen(false)}
          >
            Keep goal
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={archiveGoal.isPending || !editingGoal}
            onClick={() => {
              if (editingGoal) archiveGoal.mutate(editingGoal.id);
            }}
          >
            {archiveGoal.isPending ? "Archiving…" : "Archive goal"}
          </Button>
        </DialogActions>
      </Dialog>
      <ContributionDialog
        goal={contributionGoal}
        amount={contributionAmount}
        setAmount={setContributionAmount}
        contributedOn={contributionDate}
        setContributedOn={setContributionDate}
        note={contributionNote}
        setNote={setContributionNote}
        history={contributionsQuery.data?.data ?? []}
        historyLoading={contributionsQuery.isPending && !demo}
        readOnly={demo}
        saving={contribute.isPending}
        error={contribute.error instanceof Error ? contribute.error.message : null}
        onClose={() => setContributionGoal(null)}
        onSave={() => {
          const amount = dollarsToMinor(contributionAmount);
          if (contributionGoal && amount)
            contribute.mutate({ goalId: contributionGoal.id, amount });
        }}
      />
      <WhatIfDialog
        goal={whatIf}
        target={whatIfTarget}
        setTarget={setWhatIfTarget}
        monthly={whatIfMonthly}
        setMonthly={setWhatIfMonthly}
        readOnly={demo}
        saving={updateGoal.isPending}
        error={updateGoal.error instanceof Error ? updateGoal.error.message : null}
        onClose={() => setWhatIf(null)}
        onSave={() => {
          const target = dollarsToMinor(whatIfTarget);
          const monthly = dollarsToMinor(whatIfMonthly);
          if (!whatIf || !target || monthly === null) return;
          updateGoal.mutate(
            {
              id: whatIf.id,
              patch: {
                target: { minorUnits: target, currency: whatIf.record.target.currency },
                monthlyContribution: {
                  minorUnits: monthly,
                  currency: whatIf.record.target.currency,
                },
              },
            },
            { onSuccess: () => setWhatIf(null) },
          );
        }}
      />
    </Stack>
  );
}
