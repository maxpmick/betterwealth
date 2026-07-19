import { AddRounded, RemoveCircleOutlineRounded } from "@mui/icons-material";
import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  MenuItem,
  Paper,
  Tooltip,
} from "@mui/material";
import { useEffect, useState } from "react";
import type { ApiCategory, ApiEnvelope, ApiTransactionDetail } from "../../api";
import { Dialog, Stack, TextField } from "../mui";
import { DialogHeading } from "./DialogHeading";
import type { SplitDraft, TransactionView } from "./types";
import { formatMinorUnits, minorUnitsToInput, parsePositiveCurrencyMinorUnits } from "./utils";

interface SplitRowDraft {
  key: number;
  amount: string;
  categoryId: string;
  envelopeId: string;
  memo: string;
}

function initialSplitRows(item: TransactionView, detail?: ApiTransactionDetail): SplitRowDraft[] {
  if (detail?.splits.length) {
    return detail.splits.map((split, index) => ({
      key: index,
      amount: minorUnitsToInput(BigInt(split.amount.minorUnits)),
      categoryId: split.categoryId ?? "",
      envelopeId: split.envelopeId ?? "",
      memo: split.memo ?? "",
    }));
  }
  const absolute =
    BigInt(item.amountMinorUnits) < 0n
      ? -BigInt(item.amountMinorUnits)
      : BigInt(item.amountMinorUnits);
  const first = absolute / 2n;
  const second = absolute - first;
  return [
    { key: 0, amount: minorUnitsToInput(first), categoryId: "", envelopeId: "", memo: "" },
    { key: 1, amount: minorUnitsToInput(second), categoryId: "", envelopeId: "", memo: "" },
  ];
}

export function SplitTransactionDialog({
  open,
  item,
  detail,
  categories,
  envelopes,
  onClose,
  onSubmit,
}: {
  open: boolean;
  item: TransactionView | null;
  detail: ApiTransactionDetail | undefined;
  categories: ApiCategory[];
  envelopes: ApiEnvelope[];
  onClose: () => void;
  onSubmit: (splits: SplitDraft[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<SplitRowDraft[]>([]);
  const [nextKey, setNextKey] = useState(2);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !item) return;
    const initial = initialSplitRows(item, detail);
    setRows(initial);
    setNextKey(Math.max(2, ...initial.map(({ key }) => key + 1)));
    setError("");
  }, [detail, item, open]);

  if (!item) return null;
  const total =
    BigInt(item.amountMinorUnits) < 0n
      ? -BigInt(item.amountMinorUnits)
      : BigInt(item.amountMinorUnits);
  const parsed = rows.map(({ amount }) => parsePositiveCurrencyMinorUnits(amount));
  const parsedTotal = parsed.reduce<bigint>((sum, amount) => sum + (amount ?? 0n), 0n);
  const exact = parsed.every((amount) => amount !== null) && parsedTotal === total;
  const difference = total - parsedTotal;
  const validationMessage = parsed.some((amount) => amount === null)
    ? "Enter a positive amount with no more than two decimal places for every split."
    : difference === 0n
      ? "Every cent is assigned."
      : difference > 0n
        ? `${formatMinorUnits(difference, item.currency)} still needs a category.`
        : `${formatMinorUnits(-difference, item.currency)} is assigned too much.`;

  const updateRow = (key: number, patch: Partial<SplitRowDraft>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setError("");
  };
  const submit = async () => {
    if (!exact) return;
    setSaving(true);
    setError("");
    try {
      const negative = BigInt(item.amountMinorUnits) < 0n;
      await onSubmit(
        rows.map((row, index) => {
          const amount = parsed[index];
          if (amount == null) throw new Error("Every split needs a valid amount.");
          return {
            amountMinorUnits: (negative ? -amount : amount).toString(),
            ...(row.categoryId ? { categoryId: row.categoryId } : {}),
            ...(row.envelopeId ? { envelopeId: row.envelopeId } : {}),
            ...(row.memo.trim() ? { memo: row.memo.trim() } : {}),
          };
        }),
      );
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The split could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle component="div">
        <DialogHeading
          eyebrow="Exact allocation"
          title={detail?.splits.length ? "Edit transaction split" : "Split transaction"}
          description={`${item.merchant} · ${formatMinorUnits(BigInt(item.amountMinorUnits), item.currency)}`}
        />
      </DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 4 }}>
          Split amounts must equal the original transaction exactly. Reports use these parts instead
          of double-counting the parent.
        </Alert>
        <Stack gap={3}>
          {rows.map((row, index) => (
            <Paper key={row.key} variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
              <Stack
                direction={{ xs: "column", md: "row" }}
                gap={2}
                alignItems={{ xs: "stretch", md: "flex-start" }}
              >
                <TextField
                  label={`Split ${index + 1} amount`}
                  value={row.amount}
                  onChange={(event) => updateRow(row.key, { amount: event.target.value })}
                  inputMode="decimal"
                  InputProps={{
                    startAdornment: <InputAdornment position="start">$</InputAdornment>,
                  }}
                  sx={{ minWidth: 145 }}
                />
                <TextField
                  select
                  label={`Split ${index + 1} category`}
                  value={row.categoryId}
                  onChange={(event) => updateRow(row.key, { categoryId: event.target.value })}
                  sx={{ minWidth: 180, flex: 1 }}
                >
                  <MenuItem value="">No category</MenuItem>
                  {categories
                    .filter(({ active }) => active)
                    .map((category) => (
                      <MenuItem key={category.id} value={category.id}>
                        {category.name}
                      </MenuItem>
                    ))}
                </TextField>
                <TextField
                  select
                  label={`Split ${index + 1} envelope`}
                  value={row.envelopeId}
                  onChange={(event) => updateRow(row.key, { envelopeId: event.target.value })}
                  sx={{ minWidth: 180, flex: 1 }}
                >
                  <MenuItem value="">No envelope</MenuItem>
                  {envelopes.map((envelope) => (
                    <MenuItem key={envelope.id} value={envelope.id}>
                      {envelope.name}
                    </MenuItem>
                  ))}
                </TextField>
                <Tooltip
                  title={rows.length <= 2 ? "A split needs at least two parts" : "Remove part"}
                >
                  <span>
                    <IconButton
                      disabled={rows.length <= 2}
                      aria-label={`Remove split ${index + 1}`}
                      onClick={() =>
                        setRows((current) => current.filter(({ key }) => key !== row.key))
                      }
                    >
                      <RemoveCircleOutlineRounded />
                    </IconButton>
                  </span>
                </Tooltip>
              </Stack>
              <TextField
                label={`Split ${index + 1} memo (optional)`}
                value={row.memo}
                onChange={(event) => updateRow(row.key, { memo: event.target.value })}
                fullWidth
                sx={{ mt: 2 }}
              />
            </Paper>
          ))}
        </Stack>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          justifyContent="space-between"
          gap={2}
          sx={{ mt: 3 }}
        >
          <Button
            startIcon={<AddRounded />}
            onClick={() => {
              setRows((current) => [
                ...current,
                { key: nextKey, amount: "0.00", categoryId: "", envelopeId: "", memo: "" },
              ]);
              setNextKey((current) => current + 1);
            }}
          >
            Add another part
          </Button>
          <Alert severity={exact ? "success" : "warning"} sx={{ py: 0 }}>
            {validationMessage}
          </Alert>
        </Stack>
        {error ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {error}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!exact || saving} onClick={() => void submit()}>
          {saving ? "Saving split…" : detail?.splits.length ? "Update split" : "Save split"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
