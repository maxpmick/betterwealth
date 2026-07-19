import {
  AccountBalanceRounded,
  AddRounded,
  CloseRounded,
  CloudSyncRounded,
  CreditCardRounded,
  DirectionsCarRounded,
  LinkRounded,
  OpenInNewRounded,
  ReceiptLongRounded,
  RefreshRounded,
  RestoreRounded,
  SavingsRounded,
  ShowChartRounded,
  WalletRounded,
} from "@mui/icons-material";
import {
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
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Tab,
  Tabs,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { LineChart } from "@mui/x-charts/LineChart";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import {
  type AccountUpdateInput,
  type ApiAccount,
  type ApiAsset,
  type ApiTransaction,
  api,
  type ManualAccountInput,
} from "../api";
import { Drawer, Stack, TextField, Typography } from "../components/mui";
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
import { isDemoMode } from "../demo";
import { demoAccounts, demoAssets, demoBalanceHistory } from "../demoApi";
import { chartTickFormatter, minorToMajor } from "../lib/money";

const groupLabels: Record<ApiAccount["group"], string> = {
  cash: "Cash",
  credit: "Credit",
  loan: "Loans",
  investment: "Investments",
  property: "Property",
  vehicle: "Vehicles",
  crypto: "Crypto",
  custom: "Custom",
};

// User-facing SimpleFIN dashboard: re-authenticating a bank (e.g. after a con.auth provider
// warning) happens there, not in BetterWealth.
const SIMPLEFIN_ACCOUNT_URL = "https://beta-bridge.simplefin.org/";

interface AccountView {
  id: string;
  name: string;
  institution: string;
  type: string;
  group: string;
  mask: string;
  /** Display-only number derived from balanceMinorUnits via minorToMajor. */
  balance: number;
  balanceMinorUnits: string;
  status: "Healthy" | "Manual" | "Attention";
  updated: string;
  groupKey: ApiAccount["group"];
  accountType: string;
  accountSubtype: string;
  accountStatus: NonNullable<ApiAccount["status"]>;
}

export function parseSignedCurrencyMinorUnits(value: string): string | null {
  const normalized = value.trim().replace(/[$,\s]/g, "");
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const negative = normalized.startsWith("-");
  const unsigned = normalized.replace(/^[+-]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return (negative && minor !== 0n ? -minor : minor).toString();
}

function toAccountItem(account: ApiAccount): AccountView {
  const accountType = account.subtype || account.type;
  return {
    id: account.id,
    name: account.name,
    institution:
      account.syncStatus === "manual" || account.isManual
        ? "Manual"
        : account.institutionName || "Connected account",
    type: accountType
      ? accountType.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase())
      : groupLabels[account.group],
    group: groupLabels[account.group],
    mask: account.mask,
    balance: minorToMajor(account.balance.minorUnits, account.balance.currency),
    balanceMinorUnits: account.balance.minorUnits,
    status:
      account.syncStatus === "healthy"
        ? "Healthy"
        : account.syncStatus === "manual"
          ? "Manual"
          : "Attention",
    updated: new Date(account.updatedAt).toLocaleString(),
    groupKey: account.group,
    accountType: account.type ?? (account.syncStatus === "manual" ? "manual" : account.group),
    accountSubtype: account.subtype ?? "",
    accountStatus: account.status ?? "active",
  };
}

function AccountIcon({ group }: { group: string }) {
  const props = { fontSize: "small" as const };
  if (group === "Cash") return <WalletRounded {...props} />;
  if (group === "Investments") return <ShowChartRounded {...props} />;
  if (group === "Credit") return <CreditCardRounded {...props} />;
  if (group === "Loans") return <AccountBalanceRounded {...props} />;
  return <SavingsRounded {...props} />;
}

function AccountRow({ account, onOpen }: { account: AccountView; onOpen: () => void }) {
  return (
    <Button
      color="inherit"
      onClick={onOpen}
      sx={{
        width: "100%",
        p: 3,
        justifyContent: "stretch",
        textAlign: "left",
        minWidth: 0,
      }}
    >
      <Stack direction="row" alignItems="center" gap={3} sx={{ width: "100%", minWidth: 0 }}>
        <Box
          sx={{
            width: 42,
            height: 42,
            borderRadius: 1,
            flex: "0 0 auto",
            bgcolor: "action.hover",
            color:
              account.group === "Credit" || account.group === "Loans"
                ? "error.main"
                : "success.main",
            display: "grid",
            placeItems: "center",
          }}
        >
          <AccountIcon group={account.group} />
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="body2" noWrap>
            {account.name}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {account.institution} · ••{account.mask.slice(-2)} · {account.type}
          </Typography>
        </Box>
        <Box sx={{ textAlign: "right", ml: 2 }}>
          <Typography variant="body2">
            <Money value={account.balance} />
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Updated {account.updated}
          </Typography>
        </Box>
      </Stack>
    </Button>
  );
}

function AccountDetail({
  account,
  onClose,
  onSave,
  saving,
  error,
}: {
  account: AccountView | null;
  onClose: () => void;
  onSave: (id: string, input: AccountUpdateInput) => Promise<void>;
  saving: boolean;
  error: string | null;
}) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const { privacyEnabled } = usePrivacy();
  const demo = isDemoMode();
  const [tab, setTab] = useState("overview");
  const [name, setName] = useState(account?.name ?? "");
  const [accountGroup, setAccountGroup] = useState<ApiAccount["group"]>(
    account?.groupKey ?? "cash",
  );
  const [accountType, setAccountType] = useState(account?.accountType ?? "");
  const [accountSubtype, setAccountSubtype] = useState(account?.accountSubtype ?? "");
  const [accountStatus, setAccountStatus] = useState<NonNullable<ApiAccount["status"]>>(
    account?.accountStatus ?? "active",
  );
  const [recordedBalance, setRecordedBalance] = useState(
    account ? account.balance.toFixed(2) : "0.00",
  );
  useEffect(() => {
    setName(account?.name ?? "");
    setAccountGroup(account?.groupKey ?? "cash");
    setAccountType(account?.accountType ?? "");
    setAccountSubtype(account?.accountSubtype ?? "");
    setAccountStatus(account?.accountStatus ?? "active");
    setRecordedBalance(account ? account.balance.toFixed(2) : "0.00");
  }, [account]);
  const balanceQuery = useQuery({
    queryKey: ["account-balances", account?.id],
    queryFn: () =>
      account
        ? api.accountBalances(account.id)
        : Promise.reject(new Error("Select an account to load its balance history.")),
    enabled: Boolean(account) && !demo,
    initialData: demo && account ? demoBalanceHistory(account) : undefined,
    retry: 1,
  });
  const transactionsQuery = useQuery({
    queryKey: ["transactions", "account", account?.id],
    queryFn: () =>
      account
        ? api.accountTransactions(account.id, 100)
        : Promise.reject(new Error("Select an account to load its recent activity.")),
    enabled: Boolean(account) && !demo && tab === "activity",
    retry: 1,
  });
  if (!account) return null;
  const history =
    balanceQuery.data?.data.map((snapshot) => ({
      date: new Date(snapshot.asOf).toLocaleDateString("en-US", {
        month: "short",
        day: snapshot.asOf.slice(8, 10) === "01" ? undefined : "numeric",
        year: (balanceQuery.data?.data.length ?? 0) > 12 ? "2-digit" : undefined,
      }),
      balance: minorToMajor(snapshot.current.minorUnits, snapshot.current.currency),
    })) ?? [];
  const balanceCurrency = balanceQuery.data?.summary.current.currency ?? "USD";
  const activity =
    transactionsQuery.data?.data.filter((transaction) => transaction.status !== "removed") ?? [];
  const recordedBalanceMinorUnits = parseSignedCurrencyMinorUnits(recordedBalance);
  const normalizedName = name.trim();
  const normalizedType = accountType.trim();
  const normalizedSubtype = accountSubtype.trim() || null;
  const accountPatch: AccountUpdateInput = {
    ...(normalizedName !== account.name ? { name: normalizedName } : {}),
    ...(accountGroup !== account.groupKey ? { group: accountGroup } : {}),
    ...(normalizedType !== account.accountType ? { type: normalizedType } : {}),
    ...(normalizedSubtype !== (account.accountSubtype || null)
      ? { subtype: normalizedSubtype }
      : {}),
    ...(accountStatus !== account.accountStatus ? { status: accountStatus } : {}),
    ...(account.status === "Manual" &&
    recordedBalanceMinorUnits !== null &&
    recordedBalanceMinorUnits !== account.balanceMinorUnits
      ? { balanceMinorUnits: recordedBalanceMinorUnits }
      : {}),
  };
  const hasChanges = Object.keys(accountPatch).length > 0;
  return (
    <Drawer
      anchor="right"
      open
      onClose={onClose}
      PaperProps={{ sx: { width: mobile ? "100%" : 600, maxWidth: "100%" } }}
    >
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        sx={{ p: 4, borderBottom: "1px solid", borderColor: "divider" }}
      >
        <Box>
          <Typography variant="caption" color="text.secondary">
            {account.institution} · ••{account.mask.slice(-2)}
          </Typography>
          <Typography component="h3" variant="h6" sx={{ mt: 0.5 }}>
            {account.name}
          </Typography>
        </Box>
        <IconButton onClick={onClose} aria-label="Close account detail">
          <CloseRounded />
        </IconButton>
      </Stack>
      <Tabs
        value={tab}
        onChange={(_, value: string) => setTab(value)}
        variant="scrollable"
        scrollButtons={false}
        sx={{ px: 3, borderBottom: "1px solid", borderColor: "divider" }}
      >
        <Tab value="overview" label="Overview" />
        <Tab value="activity" label="Transactions" />
      </Tabs>
      <Box sx={{ p: { xs: 4, sm: 5 }, overflowY: "auto", flex: 1 }}>
        {tab === "overview" ? (
          <>
            <Stack direction="row" justifyContent="space-between">
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Current balance
                </Typography>
                <Typography component="p" variant="h4" sx={{ mt: 0.5 }}>
                  <Money
                    value={
                      balanceQuery.data
                        ? minorToMajor(
                            balanceQuery.data.summary.current.minorUnits,
                            balanceQuery.data.summary.current.currency,
                          )
                        : account.balance
                    }
                    currency={balanceCurrency}
                  />
                </Typography>
              </Box>
              <StatusChip
                label={account.status}
                tone={
                  account.status === "Healthy"
                    ? "positive"
                    : account.status === "Manual"
                      ? "neutral"
                      : "warning"
                }
              />
            </Stack>
            <Box sx={{ mt: 4 }}>
              {balanceQuery.isPending ? (
                <LoadingCard rows={3} />
              ) : balanceQuery.isError ? (
                <ErrorState
                  message="Balance history could not be loaded."
                  onRetry={() => balanceQuery.refetch()}
                />
              ) : privacyEnabled ? (
                <ChartMaskedState />
              ) : history.length ? (
                <LineChart
                  height={240}
                  dataset={history}
                  xAxis={[{ dataKey: "date", scaleType: "point" }]}
                  yAxis={[
                    {
                      valueFormatter: chartTickFormatter(balanceCurrency),
                      width: 50,
                    },
                  ]}
                  series={[
                    {
                      dataKey: "balance",
                      label: "Current balance",
                      area: true,
                      showMark: history.length < 12,
                      color: theme.palette.success.main,
                      valueFormatter: (value: number | null) =>
                        formatMoney(Number(value ?? 0), balanceCurrency),
                    },
                  ]}
                  margin={{ left: 4, right: 12, top: 10, bottom: 4 }}
                />
              ) : (
                <Alert severity="info">No dated balance snapshots are available yet.</Alert>
              )}
            </Box>
            <Typography variant="body2" color="text.secondary">
              {privacyEnabled
                ? "Balance history is hidden."
                : history.length
                  ? `${history.length} dated balance snapshot${history.length === 1 ? "" : "s"}; latest ${balanceQuery.data?.summary.latestAsOf ? new Date(balanceQuery.data.summary.latestAsOf).toLocaleString() : "date unavailable"}.`
                  : "Sync or update this account to create a dated snapshot."}
            </Typography>
            <Divider sx={{ my: 5 }} />
            <TextField
              label="Display name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              fullWidth
            />
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
                gap: 3,
                mt: 3,
              }}
            >
              <TextField
                select
                label="Account group"
                value={accountGroup}
                onChange={(event) => setAccountGroup(event.target.value as ApiAccount["group"])}
              >
                {(Object.entries(groupLabels) as Array<[ApiAccount["group"], string]>).map(
                  ([value, label]) => (
                    <MenuItem key={value} value={value}>
                      {label}
                    </MenuItem>
                  ),
                )}
              </TextField>
              <TextField
                select
                label="Account status"
                value={accountStatus}
                onChange={(event) =>
                  setAccountStatus(event.target.value as NonNullable<ApiAccount["status"]>)
                }
              >
                <MenuItem value="active">Active</MenuItem>
                <MenuItem value="hidden">Hidden</MenuItem>
                <MenuItem value="closed">Closed</MenuItem>
                {accountStatus === "stale" ? (
                  <MenuItem value="stale">Needs attention (provider)</MenuItem>
                ) : null}
              </TextField>
              <TextField
                label="Account type"
                value={accountType}
                onChange={(event) => setAccountType(event.target.value)}
                helperText="Examples: checking, credit card, brokerage, mortgage"
              />
              <TextField
                label="Account subtype (optional)"
                value={accountSubtype}
                onChange={(event) => setAccountSubtype(event.target.value)}
              />
            </Box>
            {account.status === "Manual" ? (
              <TextField
                label="Recorded balance"
                value={recordedBalance}
                onChange={(event) => setRecordedBalance(event.target.value)}
                error={recordedBalanceMinorUnits === null}
                helperText="Saving appends a dated manual balance snapshot; use a negative value for debt."
                InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
                fullWidth
                sx={{ mt: 3 }}
              />
            ) : (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2 }}>
                Connected balances are read-only and update through provider sync.
              </Typography>
            )}
            {error ? (
              <Alert severity="error" sx={{ mt: 3 }}>
                {error}
              </Alert>
            ) : null}
          </>
        ) : transactionsQuery.isPending ? (
          <LoadingCard rows={5} />
        ) : transactionsQuery.isError ? (
          <ErrorState
            message="Account transactions could not be loaded."
            onRetry={() => transactionsQuery.refetch()}
          />
        ) : activity.length ? (
          <Stack>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 2 }}>
              {transactionsQuery.data?.page.hasMore
                ? "Showing the 100 most recent ledger entries for this account. Older activity remains available in the full ledger."
                : `Showing ${activity.length} recent ledger entr${activity.length === 1 ? "y" : "ies"} for this account.`}
            </Typography>
            <Stack divider={<Divider />}>
              {activity.map((transaction: ApiTransaction) => (
                <Stack
                  key={transaction.id}
                  direction="row"
                  alignItems="center"
                  gap={2.5}
                  sx={{ py: 2.5 }}
                >
                  <Box
                    sx={{
                      width: 38,
                      height: 38,
                      borderRadius: 1,
                      display: "grid",
                      placeItems: "center",
                      bgcolor: "action.hover",
                      color: "text.secondary",
                    }}
                  >
                    <ReceiptLongRounded fontSize="small" />
                  </Box>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="body2" noWrap>
                      {transaction.merchant || transaction.description}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {transaction.categoryName} ·{" "}
                      {new Date(transaction.effectiveDate).toLocaleDateString()}
                    </Typography>
                  </Box>
                  <Typography variant="body2">
                    <Money
                      value={minorToMajor(
                        transaction.amount.minorUnits,
                        transaction.amount.currency,
                      )}
                      currency={transaction.amount.currency}
                      sign
                    />
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </Stack>
        ) : (
          <EmptyState
            icon={<ReceiptLongRounded />}
            title="No transactions for this account"
            description="Imported and manual activity will appear here after it reaches the ledger."
            actionLabel="Open ledger"
            onAction={() => {
              window.location.href = "/transactions";
            }}
          />
        )}
      </Box>
      <Stack
        direction="row"
        justifyContent="space-between"
        sx={{ p: 4, borderTop: "1px solid", borderColor: "divider" }}
      >
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        {tab === "overview" ? (
          <Button
            variant="contained"
            disabled={
              !normalizedName ||
              !normalizedType ||
              !hasChanges ||
              saving ||
              (account.status === "Manual" && recordedBalanceMinorUnits === null)
            }
            onClick={() => void onSave(account.id, accountPatch)}
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        ) : (
          <Button component={RouterLink} to="/transactions" variant="contained">
            Open full ledger
          </Button>
        )}
      </Stack>
    </Drawer>
  );
}

export function AccountsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<AccountView | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"choose" | "account" | "asset">("choose");
  const [name, setName] = useState("");
  const [group, setGroup] = useState<ApiAccount["group"]>("cash");
  const [balance, setBalance] = useState("0");
  const [demoAccountData, setDemoAccountData] = useState<ApiAccount[]>(demoAccounts.data);
  const [demoAssetData, setDemoAssetData] = useState<ApiAsset[]>(demoAssets.data);
  const [demoMessage, setDemoMessage] = useState("");
  const demo = isDemoMode();
  const queryClient = useQueryClient();
  const newBalanceMinorUnits = parseSignedCurrencyMinorUnits(balance);
  const chooseAddMode = (mode: "account" | "asset") => {
    setAddMode(mode);
    setGroup(mode === "account" ? "cash" : "property");
  };
  useEffect(() => {
    if (searchParams.get("action") !== "add") return;
    setAddMode("choose");
    setAddOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("action");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: api.accounts,
    initialData: demo ? demoAccounts : undefined,
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
  const connectionsQuery = useQuery({
    queryKey: ["connections"],
    queryFn: api.connections,
    initialData: demo ? { data: [], page: { cursor: null, hasMore: false } } : undefined,
    enabled: !demo,
    retry: 1,
  });
  const accountData = demo ? demoAccountData : (accountsQuery.data?.data ?? []);
  const assetData = demo ? demoAssetData : (assetsQuery.data?.data ?? []);
  const activeAccountItems = accountData
    .filter((account) => account.status !== "hidden" && account.status !== "closed")
    .map(toAccountItem);
  const archivedAccountItems = accountData
    .filter((account) => account.status === "hidden" || account.status === "closed")
    .map(toAccountItem);
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["accounts"] }),
      queryClient.invalidateQueries({ queryKey: ["assets"] }),
    ]);
  };
  const createAccount = useMutation({
    mutationFn: (input: ManualAccountInput) => api.createAccount(input),
    onSuccess: async () => {
      setAddOpen(false);
      setName("");
      await invalidate();
    },
  });
  const createAsset = useMutation({
    mutationFn: () =>
      api.createAsset({
        name,
        type: group === "vehicle" ? "vehicle" : group === "property" ? "property" : "custom",
        currency: "USD",
        value: { minorUnits: newBalanceMinorUnits ?? "0", currency: "USD" },
        valuedAt: new Date().toISOString(),
        source: "manual",
        confidence: "medium",
        liquidityClass: "illiquid",
      }),
    onSuccess: async () => {
      setAddOpen(false);
      setName("");
      await invalidate();
    },
  });
  const updateAccount = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof api.updateAccount>[1] }) =>
      api.updateAccount(id, input),
    onSuccess: async (_result, variables) => {
      setSelected(null);
      await Promise.all([
        invalidate(),
        queryClient.invalidateQueries({ queryKey: ["account-balances", variables.id] }),
      ]);
    },
  });
  const sync = useMutation({
    mutationFn: api.sync,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["accounts"] }),
  });
  const groups = [...new Set(activeAccountItems.map((account) => account.group))];
  const totals = useMemo(
    () => ({
      assets:
        activeAccountItems
          .filter((item) => item.balance > 0)
          .reduce((sum, item) => sum + item.balance, 0) +
        (assetData.reduce(
          (sum, asset) => sum + minorToMajor(asset.value.minorUnits, asset.value.currency),
          0,
        ) ?? 0),
      liabilities: Math.abs(
        activeAccountItems
          .filter((item) => item.balance < 0)
          .reduce((sum, item) => sum + item.balance, 0),
      ),
      cash: activeAccountItems
        .filter((item) => item.group === "Cash")
        .reduce((sum, item) => sum + item.balance, 0),
      invested: activeAccountItems
        .filter((item) => item.group === "Investments")
        .reduce((sum, item) => sum + item.balance, 0),
    }),
    [activeAccountItems, assetData],
  );

  if (accountsQuery.isPending || assetsQuery.isPending || connectionsQuery.isPending)
    return (
      <Stack gap={4}>
        <PageHeader title="Loading balances" />
        <LoadingCard rows={8} />
      </Stack>
    );
  if (accountsQuery.isError || assetsQuery.isError || connectionsQuery.isError)
    return (
      <Stack gap={4}>
        <PageHeader title="Accounts unavailable" />
        <ErrorState
          message="BetterWealth could not load accounts and assets."
          onRetry={() => {
            void accountsQuery.refetch();
            void assetsQuery.refetch();
            void connectionsQuery.refetch();
          }}
        />
      </Stack>
    );
  const saveNew = () => {
    if (demo) {
      const now = new Date().toISOString();
      const id = `demo_${addMode}_${Date.now()}`;
      if (addMode === "account") {
        setDemoAccountData((current) => [
          ...current,
          {
            id,
            name: name.trim(),
            mask: "manual",
            group,
            balance: { minorUnits: newBalanceMinorUnits ?? "0", currency: "USD" },
            syncStatus: "manual",
            type: "manual",
            subtype: null,
            institutionName: null,
            isManual: true,
            updatedAt: now,
          },
        ]);
        setDemoMessage(`${name.trim()} was added to this interactive demo session.`);
      }
      if (addMode === "asset") {
        setDemoAssetData((current) => [
          ...current,
          {
            id,
            name: name.trim(),
            type: group === "vehicle" ? "vehicle" : group === "property" ? "property" : "custom",
            value: { minorUnits: newBalanceMinorUnits ?? "0", currency: "USD" },
            valuedAt: now,
            source: "manual",
            confidence: "medium",
            liquidityClass: "illiquid",
          },
        ]);
        setDemoMessage(`${name.trim()} was added to this interactive demo session.`);
      }
      setAddOpen(false);
      setName("");
      return;
    }
    if (addMode === "account")
      createAccount.mutate({
        name,
        group,
        type: "manual",
        currency: "USD",
        balanceMinorUnits: newBalanceMinorUnits ?? "0",
        includeInBudget: group === "cash",
      });
    if (addMode === "asset") createAsset.mutate();
  };
  return (
    <Stack gap={5}>
      <PageHeader
        title="Accounts"
        actions={
          <>
            {connectionsQuery.data?.data.length ? (
              <Button
                variant="outlined"
                startIcon={<RefreshRounded />}
                disabled={sync.isPending}
                onClick={() => (demo ? undefined : sync.mutate())}
              >
                {sync.isPending ? "Queuing…" : "Sync all"}
              </Button>
            ) : (
              <Button
                component={RouterLink}
                to="/settings?section=integrations"
                variant="outlined"
                startIcon={<LinkRounded />}
              >
                Connect SimpleFIN
              </Button>
            )}
            <Button
              variant="contained"
              startIcon={<AddRounded />}
              onClick={() => {
                setAddMode("choose");
                setAddOpen(true);
              }}
            >
              Add
            </Button>
          </>
        }
      />
      {demoMessage ? <Alert severity="success">{demoMessage}</Alert> : null}
      {sync.error instanceof Error ? <Alert severity="error">{sync.error.message}</Alert> : null}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr 1fr", lg: "repeat(4, 1fr)" },
          gap: 3,
        }}
      >
        <MetricCard
          label="Assets"
          value={<Money value={totals.assets} />}
          helper={`${activeAccountItems.filter((item) => item.balance > 0).length} active account${activeAccountItems.filter((item) => item.balance > 0).length === 1 ? "" : "s"} + ${assetData.length} asset${assetData.length === 1 ? "" : "s"}`}
        />
        <MetricCard
          label="Liabilities"
          value={<Money value={totals.liabilities} />}
          helper="Credit and loan balances"
        />
        <MetricCard
          label="Available cash"
          value={<Money value={totals.cash} />}
          helper="Included cash accounts"
        />
        <MetricCard
          label="Invested"
          value={<Money value={totals.invested} />}
          helper="Taxable + retirement"
        />
      </Box>
      <Card>
        <CardContent sx={{ p: 5 }}>
          <SectionHeader
            title="Institution connections"
            action={
              <Button
                component={RouterLink}
                to="/settings?section=integrations"
                startIcon={<LinkRounded />}
              >
                Connect institution
              </Button>
            }
          />
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", md: "repeat(3, 1fr)" },
              gap: 3,
              mt: 4,
            }}
          >
            {connectionsQuery.data?.data.length ? (
              connectionsQuery.data.data.map((connection) => (
                <Box
                  key={connection.id}
                  sx={{
                    p: 4,
                    border: "1px solid",
                    borderColor: connection.status === "attention" ? "warning.main" : "divider",
                    borderRadius: 1,
                  }}
                >
                  <Stack direction="row" alignItems="center" gap={2}>
                    <CloudSyncRounded color="action" />
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="body2">{connection.displayName}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {connection.provider} ·{" "}
                        {connection.lastSuccessfulAt
                          ? new Date(connection.lastSuccessfulAt).toLocaleString()
                          : "not synced"}
                      </Typography>
                    </Box>
                    <StatusChip
                      label={connection.status}
                      tone={connection.status === "healthy" ? "positive" : "warning"}
                    />
                  </Stack>
                  {connection.status === "attention" ? (
                    <Box sx={{ mt: 2 }}>
                      <Typography
                        variant="caption"
                        color="warning.main"
                        sx={{ display: "block", mb: 1.5 }}
                      >
                        {connection.lastErrorMessage ??
                          "The provider reported a problem with this connection."}
                      </Typography>
                      {connection.provider === "simplefin" ? (
                        <Button
                          size="small"
                          variant="outlined"
                          color="warning"
                          component="a"
                          href={SIMPLEFIN_ACCOUNT_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          endIcon={<OpenInNewRounded fontSize="small" />}
                        >
                          Open SimpleFIN to fix
                        </Button>
                      ) : null}
                    </Box>
                  ) : null}
                </Box>
              ))
            ) : (
              <Typography variant="body2" color="text.secondary">
                No provider connections. Manual accounts continue to work.
              </Typography>
            )}
          </Box>
        </CardContent>
      </Card>
      {groups.map((accountGroup) => (
        <Box key={accountGroup}>
          <SectionHeader title={accountGroup} />
          <Typography variant="body2" color="text.secondary">
            {`${activeAccountItems.filter((account) => account.group === accountGroup).length} account${activeAccountItems.filter((account) => account.group === accountGroup).length === 1 ? "" : "s"}`}
          </Typography>
          <Card sx={{ mt: 3 }}>
            <Stack divider={<Divider />}>
              {activeAccountItems
                .filter((account) => account.group === accountGroup)
                .map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    onOpen={() => setSelected(account)}
                  />
                ))}
            </Stack>
          </Card>
        </Box>
      ))}
      {!activeAccountItems.length ? (
        <EmptyState
          icon={<AccountBalanceRounded />}
          title={archivedAccountItems.length ? "No active accounts" : "No accounts yet"}
          description={
            archivedAccountItems.length
              ? "Reopen an account below, connect SimpleFIN, or add a manual opening balance."
              : "Connect SimpleFIN or add a manual opening balance."
          }
          actionLabel="Add account"
          onAction={() => {
            chooseAddMode("account");
            setAddOpen(true);
          }}
        />
      ) : null}
      {archivedAccountItems.length ? (
        <Box>
          <SectionHeader title="Hidden & closed accounts" />
          <Typography variant="body2" color="text.secondary">
            {`${archivedAccountItems.length} account${archivedAccountItems.length === 1 ? " is" : "s are"} excluded from active totals, net worth, budgets, and safe to spend. Reopening restores each account's saved inclusion settings.`}
          </Typography>
          <Card sx={{ mt: 3 }}>
            <Stack divider={<Divider />}>
              {archivedAccountItems.map((account) => (
                <Stack
                  key={account.id}
                  direction={{ xs: "column", sm: "row" }}
                  alignItems={{ xs: "stretch", sm: "center" }}
                  gap={{ xs: 0, sm: 2 }}
                  sx={{ pr: { sm: 3 }, pb: { xs: 2, sm: 0 } }}
                >
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <AccountRow account={account} onOpen={() => setSelected(account)} />
                  </Box>
                  <Stack
                    direction="row"
                    alignItems="center"
                    justifyContent={{ xs: "space-between", sm: "flex-end" }}
                    gap={2}
                    sx={{ px: { xs: 3, sm: 0 } }}
                  >
                    <StatusChip
                      label={account.accountStatus === "hidden" ? "Hidden" : "Closed"}
                      tone="neutral"
                    />
                    <Button
                      size="small"
                      aria-label={`Reopen ${account.name}`}
                      startIcon={<RestoreRounded />}
                      disabled={updateAccount.isPending}
                      onClick={() => {
                        if (demo) {
                          setDemoAccountData((current) =>
                            current.map((item) =>
                              item.id === account.id
                                ? { ...item, status: "active", updatedAt: new Date().toISOString() }
                                : item,
                            ),
                          );
                          setDemoMessage(
                            `${account.name} was reopened with its saved planning settings.`,
                          );
                          return;
                        }
                        updateAccount.mutate({ id: account.id, input: { status: "active" } });
                      }}
                    >
                      Reopen
                    </Button>
                  </Stack>
                </Stack>
              ))}
            </Stack>
          </Card>
        </Box>
      ) : null}
      <Box>
        <SectionHeader
          title="Manual assets"
          action={
            <Button
              startIcon={<AddRounded />}
              onClick={() => {
                chooseAddMode("asset");
                setAddOpen(true);
              }}
            >
              Add manual asset
            </Button>
          }
        />
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "repeat(2, 1fr)" },
            gap: 4,
            mt: 3,
          }}
        >
          {assetData.map((asset) => (
            <Card key={asset.id}>
              <CardContent sx={{ p: 5 }}>
                <Stack direction="row" gap={3}>
                  <Box
                    sx={{
                      width: 42,
                      height: 42,
                      borderRadius: 1,
                      display: "grid",
                      placeItems: "center",
                      bgcolor: "action.hover",
                      color: "text.secondary",
                    }}
                  >
                    {asset.type === "vehicle" ? <DirectionsCarRounded /> : <SavingsRounded />}
                  </Box>
                  <Box>
                    <Typography component="h3" variant="h6">
                      {asset.name}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {asset.source} · {asset.confidence} confidence
                    </Typography>
                  </Box>
                </Stack>
                <Typography component="p" variant="h5" sx={{ mt: 4 }}>
                  <Money
                    value={minorToMajor(asset.value.minorUnits, asset.value.currency)}
                    currency={asset.value.currency}
                  />
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Valued {new Date(asset.valuedAt).toLocaleDateString()} · {asset.liquidityClass}
                </Typography>
              </CardContent>
            </Card>
          ))}
        </Box>
      </Box>
      <AccountDetail
        account={selected}
        onClose={() => setSelected(null)}
        onSave={async (id, input) => {
          if (demo) {
            setDemoAccountData((current) =>
              current.map((account) =>
                account.id === id
                  ? {
                      ...account,
                      ...(input.name !== undefined ? { name: input.name } : {}),
                      ...(input.group !== undefined ? { group: input.group } : {}),
                      ...(input.type !== undefined ? { type: input.type } : {}),
                      ...(input.subtype !== undefined ? { subtype: input.subtype } : {}),
                      ...(input.status !== undefined ? { status: input.status } : {}),
                      ...(input.balanceMinorUnits !== undefined
                        ? {
                            balance: {
                              minorUnits: input.balanceMinorUnits,
                              currency: account.balance.currency,
                            },
                          }
                        : {}),
                      updatedAt: new Date().toISOString(),
                    }
                  : account,
              ),
            );
            const displayName =
              input.name ?? accountData.find((account) => account.id === id)?.name;
            setDemoMessage(
              `${displayName ?? "Account"} was updated for this interactive demo session.`,
            );
            setSelected(null);
            return;
          }
          await updateAccount.mutateAsync({
            id,
            input,
          });
        }}
        saving={updateAccount.isPending}
        error={updateAccount.error instanceof Error ? updateAccount.error.message : null}
      />
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>
          {addMode === "choose"
            ? "Add account or asset"
            : addMode === "account"
              ? "Add manual account"
              : "Add manual asset"}
        </DialogTitle>
        <DialogContent>
          {addMode === "choose" ? (
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)" },
                gap: 3,
                mt: 1,
              }}
            >
              <Button
                variant="outlined"
                color="inherit"
                onClick={() => chooseAddMode("account")}
                sx={{ p: 4 }}
              >
                <Stack alignItems="flex-start">
                  <AccountBalanceRounded />
                  <Typography variant="body2" sx={{ mt: 2 }}>
                    Manual account
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Balance and transactions
                  </Typography>
                </Stack>
              </Button>
              <Button
                variant="outlined"
                color="inherit"
                onClick={() => chooseAddMode("asset")}
                sx={{ p: 4 }}
              >
                <Stack alignItems="flex-start">
                  <DirectionsCarRounded />
                  <Typography variant="body2" sx={{ mt: 2 }}>
                    Manual asset
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Dated valuation
                  </Typography>
                </Stack>
              </Button>
            </Box>
          ) : (
            <Stack gap={3} sx={{ mt: 1 }}>
              <TextField
                label="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <FormControl size="small">
                <InputLabel id="new-account-group">
                  {addMode === "account" ? "Account group" : "Asset type"}
                </InputLabel>
                <Select
                  labelId="new-account-group"
                  label={addMode === "account" ? "Account group" : "Asset type"}
                  value={group}
                  onChange={(event) => setGroup(event.target.value as ApiAccount["group"])}
                >
                  {(addMode === "account"
                    ? ["cash", "credit", "loan", "investment", "crypto", "custom"]
                    : ["property", "vehicle", "custom"]
                  ).map((value) => (
                    <MenuItem key={value} value={value}>
                      {groupLabels[value as ApiAccount["group"]]}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                label={addMode === "account" ? "Opening balance" : "Current value"}
                value={balance}
                onChange={(event) => setBalance(event.target.value)}
                error={
                  newBalanceMinorUnits === null ||
                  (addMode === "asset" &&
                    newBalanceMinorUnits !== null &&
                    BigInt(newBalanceMinorUnits) < 0n)
                }
                helperText={
                  addMode === "asset"
                    ? "Enter a non-negative current estimate."
                    : "Use a negative opening balance for credit or loan debt."
                }
                InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
              />
            </Stack>
          )}
        </DialogContent>
        {createAccount.error instanceof Error || createAsset.error instanceof Error ? (
          <Alert severity="error" sx={{ mx: 3 }}>
            {(createAccount.error ?? (createAsset.error as Error)).message}
          </Alert>
        ) : null}
        <DialogActions>
          <Button onClick={() => (addMode === "choose" ? setAddOpen(false) : setAddMode("choose"))}>
            {addMode === "choose" ? "Cancel" : "Back"}
          </Button>
          {addMode !== "choose" ? (
            <Button
              variant="contained"
              disabled={
                !name.trim() ||
                newBalanceMinorUnits === null ||
                (addMode === "asset" && BigInt(newBalanceMinorUnits) < 0n) ||
                createAccount.isPending ||
                createAsset.isPending
              }
              onClick={saveNew}
            >
              {createAccount.isPending || createAsset.isPending ? "Saving…" : "Add"}
            </Button>
          ) : null}
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
