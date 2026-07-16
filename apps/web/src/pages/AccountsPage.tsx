import {
  AccountBalanceRounded,
  AddRounded,
  CheckCircleRounded,
  CloseRounded,
  CloudSyncRounded,
  CreditCardRounded,
  DirectionsCarRounded,
  LinkRounded,
  ReceiptLongRounded,
  RefreshRounded,
  SavingsRounded,
  ShowChartRounded,
  WalletRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import {
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
  type ApiAccount,
  type ApiAccountBalanceHistory,
  type ApiAsset,
  type ApiTransaction,
  api,
  type CursorPage,
  type ManualAccountInput,
} from "../api";
import { Drawer, Stack, TextField, Typography } from "../components/mui";
import {
  ChartMaskedState,
  EmptyState,
  ErrorState,
  LoadingCard,
  MetricCard,
  Money,
  PageHeader,
  SectionHeader,
  StatusChip,
} from "../components/ui";
import { usePrivacy } from "../contexts";
import { type AccountItem, accounts as accountFixtures } from "../data";
import { isDemoMode } from "../demo";

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
const groupTransport: Record<string, ApiAccount["group"]> = {
  Cash: "cash",
  Credit: "credit",
  Loans: "loan",
  Investments: "investment",
  Property: "property",
  Vehicles: "vehicle",
  Crypto: "crypto",
  Custom: "custom",
};

export function parseSignedCurrencyMinorUnits(value: string): string | null {
  const normalized = value.trim().replace(/[$,\s]/g, "");
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const negative = normalized.startsWith("-");
  const unsigned = normalized.replace(/^[+-]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return (negative && minor !== 0n ? -minor : minor).toString();
}

const demoAccounts: CursorPage<ApiAccount> = {
  data: accountFixtures.map((account) => ({
    id: account.id,
    name: account.name,
    mask: account.mask,
    group: groupTransport[account.group] ?? "custom",
    balance: { minorUnits: String(Math.round(account.balance * 100)), currency: "USD" },
    syncStatus:
      account.status === "Healthy"
        ? "healthy"
        : account.status === "Manual"
          ? "manual"
          : "attention",
    updatedAt: "2026-07-16T10:42:00.000Z",
  })),
  page: { cursor: null, hasMore: false },
};
const demoAssets: CursorPage<ApiAsset> = {
  data: [
    {
      id: "asset_car",
      name: "2019 Honda Civic",
      type: "vehicle",
      value: { minorUnits: "950000", currency: "USD" },
      valuedAt: "2026-07-01T00:00:00.000Z",
      source: "manual",
      confidence: "medium",
      liquidityClass: "illiquid",
    },
    {
      id: "asset_deposit",
      name: "Apartment security deposit",
      type: "custom",
      value: { minorUnits: "250000", currency: "USD" },
      valuedAt: "2025-09-03T00:00:00.000Z",
      source: "manual",
      confidence: "high",
      liquidityClass: "illiquid",
    },
  ],
  page: { cursor: null, hasMore: false },
};

function demoBalanceHistory(account: AccountItem): ApiAccountBalanceHistory {
  const currentMinor = Math.round(account.balance * 100);
  const changes = [-1_850, -1_200, -780, -320, -90, 0];
  return {
    account: { id: account.id, name: account.name, currency: "USD" },
    data: changes.map((change, index) => {
      const value = currentMinor + change * 100;
      return {
        id: `demo-balance-${index}`,
        asOf: `2026-${String(index + 2).padStart(2, "0")}-01T12:00:00.000Z`,
        current: { minorUnits: String(value), currency: "USD" },
        ledger: { minorUnits: String(value), currency: "USD" },
        available: { minorUnits: String(value), currency: "USD" },
        source: "fixture",
        reconciled: true,
      };
    }),
    summary: {
      current: { minorUnits: String(currentMinor), currency: "USD" },
      change: { minorUnits: "185000", currency: "USD" },
      latestAsOf: "2026-07-01T12:00:00.000Z",
      reconciled: true,
    },
  };
}

function toAccountItem(account: ApiAccount): AccountItem {
  return {
    id: account.id,
    name: account.name,
    institution: account.syncStatus === "manual" ? "Manual" : "Connected institution",
    type: groupLabels[account.group],
    group: groupLabels[account.group],
    mask: account.mask,
    balance: Number(account.balance.minorUnits) / 100,
    change: 0,
    status:
      account.syncStatus === "healthy"
        ? "Healthy"
        : account.syncStatus === "manual"
          ? "Manual"
          : "Attention",
    updated: new Date(account.updatedAt).toLocaleString(),
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

function AccountRow({ account, onOpen }: { account: AccountItem; onOpen: () => void }) {
  return (
    <Button
      color="inherit"
      onClick={onOpen}
      sx={{
        width: "100%",
        p: 3,
        borderRadius: 2.5,
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
            borderRadius: 2.5,
            flex: "0 0 auto",
            bgcolor:
              account.group === "Credit" || account.group === "Loans"
                ? alpha("#DD625B", 0.1)
                : alpha("#1F9D72", 0.1),
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
          <Typography variant="body2" fontWeight={720} noWrap>
            {account.name}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {account.institution} · ••{account.mask.slice(-2)} · {account.type}
          </Typography>
        </Box>
        <Box sx={{ textAlign: "right", ml: 2 }}>
          <Typography variant="body2" fontWeight={760}>
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
  account: AccountItem | null;
  onClose: () => void;
  onSave: (id: string, name: string, balanceMinorUnits?: string) => Promise<void>;
  saving: boolean;
  error: string | null;
}) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const { privacyEnabled } = usePrivacy();
  const demo = isDemoMode();
  const [tab, setTab] = useState("overview");
  const [name, setName] = useState(account?.name ?? "");
  const [recordedBalance, setRecordedBalance] = useState(
    account ? account.balance.toFixed(2) : "0.00",
  );
  useEffect(() => {
    setName(account?.name ?? "");
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
    queryFn: () => api.transactions(""),
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
      balance: Number(snapshot.current.minorUnits) / 100,
    })) ?? [];
  const activity =
    transactionsQuery.data?.data.filter(
      (transaction) =>
        transaction.accountId === account.id ||
        (!transaction.accountId && transaction.accountName === account.name),
    ) ?? [];
  const reconciliation = balanceQuery.data?.summary.reconciled;
  const recordedBalanceMinorUnits = parseSignedCurrencyMinorUnits(recordedBalance);
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
          <Typography variant="h3" sx={{ mt: 0.5 }}>
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
                <Typography sx={{ fontSize: 34, fontWeight: 760, mt: 0.5 }}>
                  <Money
                    value={
                      balanceQuery.data
                        ? Number(balanceQuery.data.summary.current.minorUnits) / 100
                        : account.balance
                    }
                    currency={balanceQuery.data?.summary.current.currency ?? "USD"}
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
                      valueFormatter: (value: number) => `$${Math.round(value / 1000)}k`,
                      width: 50,
                    },
                  ]}
                  series={[
                    {
                      dataKey: "balance",
                      label: "Current balance",
                      area: true,
                      showMark: history.length < 12,
                      color: "#1F9D72",
                      valueFormatter: (value: number | null) =>
                        `$${Number(value ?? 0).toLocaleString()}`,
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
            <SectionHeader
              title="Reconciliation"
              description="The provider’s current balance is compared with its ledger balance at the latest checkpoint."
            />
            <Box sx={{ mt: 3, p: 4, borderRadius: 3, bgcolor: "action.hover" }}>
              <Stack direction="row" gap={2} alignItems="center">
                {reconciliation === true ? (
                  <CheckCircleRounded color="success" />
                ) : reconciliation === false ? (
                  <WarningAmberRounded color="warning" />
                ) : (
                  <CloudSyncRounded color="disabled" />
                )}
                <Box>
                  <Typography variant="body2" fontWeight={700}>
                    {reconciliation === true
                      ? "Current and ledger balances agree"
                      : reconciliation === false
                        ? "Current and ledger balances differ"
                        : "No reconciliation checkpoint yet"}
                  </Typography>
                  {balanceQuery.data?.summary.latestAsOf ? (
                    <Typography variant="caption" color="text.secondary">
                      Checked {new Date(balanceQuery.data.summary.latestAsOf).toLocaleString()}
                    </Typography>
                  ) : null}
                </Box>
              </Stack>
            </Box>
            <Divider sx={{ my: 5 }} />
            <TextField
              label="Display name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              fullWidth
            />
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
          <Stack divider={<Divider />}>
            {activity.slice(0, 100).map((transaction: ApiTransaction) => (
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
                    borderRadius: 2.5,
                    display: "grid",
                    placeItems: "center",
                    bgcolor: "action.hover",
                    color: "text.secondary",
                  }}
                >
                  <ReceiptLongRounded fontSize="small" />
                </Box>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="body2" fontWeight={700} noWrap>
                    {transaction.merchant || transaction.description}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {transaction.categoryName} ·{" "}
                    {new Date(transaction.effectiveDate).toLocaleDateString()}
                  </Typography>
                </Box>
                <Typography variant="body2" fontWeight={750}>
                  <Money
                    value={Number(transaction.amount.minorUnits) / 100}
                    currency={transaction.amount.currency}
                    sign
                  />
                </Typography>
              </Stack>
            ))}
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
              !name.trim() ||
              saving ||
              (account.status === "Manual" && recordedBalanceMinorUnits === null)
            }
            onClick={() =>
              void onSave(
                account.id,
                name,
                account.status === "Manual" ? (recordedBalanceMinorUnits ?? undefined) : undefined,
              )
            }
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
  const [selected, setSelected] = useState<AccountItem | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<"choose" | "account" | "asset">("choose");
  const [name, setName] = useState("");
  const [group, setGroup] = useState<ApiAccount["group"]>("cash");
  const [balance, setBalance] = useState("0");
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
  const accountItems = accountsQuery.data?.data.map(toAccountItem) ?? [];
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
    mutationFn: ({
      id,
      displayName,
      balanceMinorUnits,
    }: {
      id: string;
      displayName: string;
      balanceMinorUnits?: string;
    }) =>
      api.updateAccount(id, {
        name: displayName,
        ...(balanceMinorUnits !== undefined ? { balanceMinorUnits } : {}),
      }),
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
  const groups = [...new Set(accountItems.map((account) => account.group))];
  const totals = useMemo(
    () => ({
      assets:
        accountItems
          .filter((item) => item.balance > 0)
          .reduce((sum, item) => sum + item.balance, 0) +
        (assetsQuery.data?.data.reduce(
          (sum, asset) => sum + Number(asset.value.minorUnits) / 100,
          0,
        ) ?? 0),
      liabilities: Math.abs(
        accountItems
          .filter((item) => item.balance < 0)
          .reduce((sum, item) => sum + item.balance, 0),
      ),
      cash: accountItems
        .filter((item) => item.group === "Cash")
        .reduce((sum, item) => sum + item.balance, 0),
      invested: accountItems
        .filter((item) => item.group === "Investments")
        .reduce((sum, item) => sum + item.balance, 0),
    }),
    [accountItems, assetsQuery.data],
  );

  if (accountsQuery.isPending || assetsQuery.isPending || connectionsQuery.isPending)
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Accounts & assets"
          title="Loading balances"
          description="Reading accounts, connection state, and dated valuations."
        />
        <LoadingCard rows={8} />
      </Stack>
    );
  if (accountsQuery.isError || assetsQuery.isError || connectionsQuery.isError)
    return (
      <Stack gap={4}>
        <PageHeader
          eyebrow="Accounts & assets"
          title="Accounts unavailable"
          description="No account truth has been changed."
        />
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
      setAddOpen(false);
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
        eyebrow="Accounts & assets"
        title="Every balance, in its proper place"
        description="Connection health stays separate from account truth. Manual accounts remain first-class and fully reconcilable."
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
          helper={`${accountItems.filter((item) => item.balance > 0).length} accounts + ${assetsQuery.data?.data.length ?? 0} assets`}
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
            description="Provider access and sync state, independent of individual accounts."
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
                  sx={{ p: 4, border: "1px solid", borderColor: "divider", borderRadius: 3 }}
                >
                  <Stack direction="row" alignItems="center" gap={2}>
                    <CloudSyncRounded color="action" />
                    <Box sx={{ flex: 1 }}>
                      <Typography variant="body2" fontWeight={720}>
                        {connection.displayName}
                      </Typography>
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
          <SectionHeader
            title={accountGroup}
            description={`${accountItems.filter((account) => account.group === accountGroup).length} account${accountItems.filter((account) => account.group === accountGroup).length === 1 ? "" : "s"}`}
          />
          <Card sx={{ mt: 3 }}>
            <Stack divider={<Divider />}>
              {accountItems
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
      {!accountItems.length ? (
        <EmptyState
          icon={<AccountBalanceRounded />}
          title="No accounts yet"
          description="Connect SimpleFIN or add a manual opening balance."
          actionLabel="Add account"
          onAction={() => {
            chooseAddMode("account");
            setAddOpen(true);
          }}
        />
      ) : null}
      <Box>
        <SectionHeader
          title="Manual assets"
          description="Dated values now; optional provider adapters later."
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
          {assetsQuery.data?.data.map((asset) => (
            <Card key={asset.id}>
              <CardContent sx={{ p: 5 }}>
                <Stack direction="row" gap={3}>
                  <Box
                    sx={{
                      width: 42,
                      height: 42,
                      borderRadius: 2.5,
                      display: "grid",
                      placeItems: "center",
                      bgcolor: alpha("#4A7FD1", 0.1),
                      color: "info.main",
                    }}
                  >
                    {asset.type === "vehicle" ? <DirectionsCarRounded /> : <SavingsRounded />}
                  </Box>
                  <Box>
                    <Typography variant="h3">{asset.name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {asset.source} · {asset.confidence} confidence
                    </Typography>
                  </Box>
                </Stack>
                <Typography sx={{ mt: 4, fontSize: 27, fontWeight: 760 }}>
                  <Money value={Number(asset.value.minorUnits) / 100} />
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
        onSave={async (id, displayName, balanceMinorUnits) => {
          if (demo) {
            setSelected(null);
            return;
          }
          await updateAccount.mutateAsync({
            id,
            displayName,
            ...(balanceMinorUnits !== undefined ? { balanceMinorUnits } : {}),
          });
        }}
        saving={updateAccount.isPending}
        error={updateAccount.error instanceof Error ? updateAccount.error.message : null}
      />
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>
          {addMode === "choose"
            ? "Add to BetterWealth"
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
                  <Typography variant="body2" fontWeight={720} sx={{ mt: 2 }}>
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
                  <Typography variant="body2" fontWeight={720} sx={{ mt: 2 }}>
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
