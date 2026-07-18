import {
  CallSplitRounded,
  CheckCircleRounded,
  CloseRounded,
  CloudDownloadRounded,
  DeleteOutlineRounded,
  ExpandMoreRounded,
  LinkRounded,
  LocalOfferRounded,
  ReceiptLongRounded,
  RuleRounded,
  SwapHorizRounded,
} from "@mui/icons-material";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Tooltip,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useEffect, useState } from "react";
import type {
  ApiCategory,
  ApiRefundLinkMatch,
  ApiTransaction,
  ApiTransactionDetail,
  ApiTransferMatch,
} from "../../api";
import { Checkbox, Dialog, Drawer, Stack, TextField, Typography } from "../mui";
import { Money, StatusChip } from "../ui";
import type { TransactionAction, TransactionView } from "./types";
import { formatMinorUnits } from "./utils";

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
              <Money value={item.amount} currency={item.currency} sign />
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
