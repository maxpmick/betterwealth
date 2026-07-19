import {
  AutoAwesomeRounded,
  CloseRounded,
  CloudDownloadRounded,
  FilterListRounded,
  MoreHorizRounded,
  RemoveCircleOutlineRounded,
  SearchRounded,
} from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  ListItemIcon,
  MenuItem,
  Paper,
  Snackbar,
  Tab,
  Tabs,
  Tooltip,
} from "@mui/material";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  type ApiRefundLinkMatch,
  type ApiRule,
  type ApiTransaction,
  type ApiTransactionImportResult,
  type ApiTransferMatch,
  api,
} from "../api";
import { Checkbox, Dialog, Drawer, Menu, Stack, TextField, Typography } from "../components/mui";
import { CreateTransactionRuleDialog } from "../components/transactions/CreateTransactionRuleDialog";
import { FilterContent } from "../components/transactions/FilterContent";
import { ImportTransactionsDialog } from "../components/transactions/ImportTransactionsDialog";
import { LinkRefundDialog } from "../components/transactions/LinkRefundDialog";
import { ManualTransactionDialog } from "../components/transactions/ManualTransactionDialog";
import { MatchTransferDialog } from "../components/transactions/MatchTransferDialog";
import { SplitTransactionDialog } from "../components/transactions/SplitTransactionDialog";
import { TransactionDetail } from "../components/transactions/TransactionDetail";
import { MobileTransactionRow, TransactionRow } from "../components/transactions/TransactionRows";
import type {
  LedgerRangeFilters,
  RuleCreateInput,
  RulePreview,
  SplitDraft,
  TransactionAction,
  TransactionView,
} from "../components/transactions/types";
import {
  displayItems,
  estimatedImportRecords,
  hasSuggestedMatch,
  matchesTransactionFilters,
  minorUnitsToInput,
  parsePositiveCurrencyMinorUnits,
} from "../components/transactions/utils";
import { ErrorState, LoadingCard, Money, PageHeader } from "../components/ui";
import { isDemoMode } from "../demo";
import {
  demoAccounts,
  demoLedgerTransactions as demoApiTransactions,
  demoCategories,
  demoEnvelopes,
} from "../demoApi";

export type { TransactionView };
// Re-exported so existing imports from this module keep working.
export {
  CreateTransactionRuleDialog,
  displayItems,
  ImportTransactionsDialog,
  LinkRefundDialog,
  ManualTransactionDialog,
  MatchTransferDialog,
  matchesTransactionFilters,
  parsePositiveCurrencyMinorUnits,
  SplitTransactionDialog,
  TransactionDetail,
};

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
    setToast(`${item.merchant} removed`);
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
    setToast(`${item.merchant} restored`);
  };
  const saveSplits = async (splits: SplitDraft[]) => {
    if (!detail) return;
    if (!demo) await api.replaceTransactionSplits(detail.id, splits);
    setDetail((current) => (current ? { ...current, hasSplits: true } : current));
    await invalidateLedgerAction();
    setToast(`${detail.merchant} split saved`);
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
    setToast("Transfer matched");
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
    setToast("Refund linked");
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
    setToast("Transfer suggestion rejected");
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
    setToast("Refund suggestion rejected");
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
    setToast(`Rule “${input.name}” created`);
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
    setToast("Transaction added");
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
        <PageHeader title="Transactions" />
        <LoadingCard rows={8} />
      </Stack>
    );
  }
  if (!demo && result.isError) {
    return (
      <Stack gap={4}>
        <PageHeader title="Transactions" />
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
        title="Transactions"
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
          need confirmation.
        </Alert>
      ) : null}
      <Paper variant="outlined" sx={{ overflow: "hidden" }}>
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
              label={`All ${allItems.filter(({ status }) => status !== "removed").length}`}
            />
            <Tab
              value="review"
              label={`Review ${allItems.filter((item) => item.status !== "removed" && (item.needsReview || hasSuggestedMatch(item))).length}`}
            />
            <Tab
              value="removed"
              label={`Removed ${allItems.filter(({ status }) => status === "removed").length}`}
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
              bgcolor: "action.hover",
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
              {allItems.length} transactions loaded
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
            <Typography variant="h3">Filters</Typography>
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
            Apply a new category to {selected.length} transactions totaling{" "}
            <Money value={selectedTotal} sign />.
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
