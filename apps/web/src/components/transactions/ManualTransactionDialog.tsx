import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  MenuItem,
} from "@mui/material";
import { useEffect, useState } from "react";
import type { ApiAccount, ApiCategory } from "../../api";
import { Dialog, Stack, TextField } from "../mui";
import { DialogHeading } from "./DialogHeading";
import { localDateTimeValue, parsePositiveCurrencyMinorUnits } from "./utils";

export function ManualTransactionDialog({
  open,
  accounts,
  categories,
  onClose,
  onSubmit,
}: {
  open: boolean;
  accounts: ApiAccount[];
  categories: ApiCategory[];
  onClose: () => void;
  onSubmit: (input: {
    accountId: string;
    amountMinorUnits: string;
    currency: string;
    effectiveDate: string;
    description: string;
    categoryId?: string;
    note?: string;
  }) => Promise<void>;
}) {
  const [accountId, setAccountId] = useState("");
  const [direction, setDirection] = useState<"expense" | "income">("expense");
  const [amount, setAmount] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(localDateTimeValue());
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setAccountId(accounts[0]?.id ?? "");
    setDirection("expense");
    setAmount("");
    setEffectiveDate(localDateTimeValue());
    setDescription("");
    setCategoryId("");
    setNote("");
    setError("");
  }, [accounts, open]);

  const parsedAmount = parsePositiveCurrencyMinorUnits(amount);
  const account = accounts.find(({ id }) => id === accountId);
  const canSave = Boolean(account && parsedAmount && description.trim() && effectiveDate);
  const submit = async () => {
    if (!account || !parsedAmount || !description.trim()) return;
    setSaving(true);
    setError("");
    try {
      await onSubmit({
        accountId: account.id,
        amountMinorUnits: (direction === "expense" ? -parsedAmount : parsedAmount).toString(),
        currency: account.balance.currency,
        effectiveDate: new Date(effectiveDate).toISOString(),
        description: description.trim(),
        ...(categoryId ? { categoryId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The transaction could not be added.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle component="div">
        <DialogHeading title="Add a transaction" />
      </DialogTitle>
      <DialogContent>
        <Stack gap={3}>
          {!accounts.length ? (
            <Alert severity="warning">Add an account before creating a manual transaction.</Alert>
          ) : null}
          <TextField
            select
            label="Account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            fullWidth
          >
            {accounts.map((option) => (
              <MenuItem key={option.id} value={option.id}>
                {option.name} · ••{option.mask.slice(-2)}
              </MenuItem>
            ))}
          </TextField>
          <Stack direction={{ xs: "column", sm: "row" }} gap={2}>
            <TextField
              select
              label="Type"
              value={direction}
              onChange={(event) => setDirection(event.target.value as "expense" | "income")}
              sx={{ minWidth: 150 }}
            >
              <MenuItem value="expense">Expense</MenuItem>
              <MenuItem value="income">Income / credit</MenuItem>
            </TextField>
            <TextField
              label="Amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
              helperText="Enter a positive amount; the selected type sets its direction."
              fullWidth
            />
          </Stack>
          <TextField
            label="Date and time"
            type="datetime-local"
            value={effectiveDate}
            onChange={(event) => setEffectiveDate(event.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
            fullWidth
          />
          <TextField
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Coffee shop, cash rent, reimbursement…"
            fullWidth
          />
          <TextField
            select
            label="Category (optional)"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            fullWidth
          >
            <MenuItem value="">Leave for review</MenuItem>
            {categories
              .filter(
                ({ active, kind }) =>
                  active && (direction === "income" ? kind === "income" : kind === "expense"),
              )
              .map((category) => (
                <MenuItem key={category.id} value={category.id}>
                  {category.name}
                </MenuItem>
              ))}
          </TextField>
          <TextField
            label="Note (optional)"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            multiline
            minRows={2}
            fullWidth
          />
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!canSave || saving} onClick={() => void submit()}>
          {saving ? "Adding…" : "Add transaction"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
