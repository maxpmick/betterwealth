import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { Dialog, TextField, Typography } from "../mui";
import { DialogHeading } from "./DialogHeading";
import type { TransactionView } from "./types";
import { candidateLabel, directionLabel } from "./utils";

export function LinkRefundDialog({
  open,
  item,
  transactions,
  onClose,
  onSubmit,
}: {
  open: boolean;
  item: TransactionView | null;
  transactions: TransactionView[];
  onClose: () => void;
  onSubmit: (input: {
    refundTransactionId: string;
    purchaseTransactionId: string;
  }) => Promise<void>;
}) {
  const [candidateId, setCandidateId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const candidates = useMemo(() => {
    if (!item) return [];
    const current = BigInt(item.amountMinorUnits);
    return transactions.filter((candidate) => {
      const other = BigInt(candidate.amountMinorUnits);
      if (
        candidate.id === item.id ||
        candidate.accountId !== item.accountId ||
        candidate.currency !== item.currency ||
        candidate.isTransfer ||
        (current < 0n ? other <= 0n : other >= 0n)
      )
        return false;
      return current < 0n ? other <= -current : -other >= current;
    });
  }, [item, transactions]);

  useEffect(() => {
    if (!open) return;
    setCandidateId(candidates.length === 1 ? (candidates[0]?.id ?? "") : "");
    setError("");
  }, [candidates, open]);

  if (!item) return null;
  const selected = candidates.find(({ id }) => id === candidateId);
  const submit = async () => {
    if (!selected) return;
    const currentIsRefund = BigInt(item.amountMinorUnits) > 0n;
    setSaving(true);
    setError("");
    try {
      await onSubmit({
        refundTransactionId: currentIsRefund ? item.id : selected.id,
        purchaseTransactionId: currentIsRefund ? selected.id : item.id,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The refund could not be linked.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle component="div">
        <DialogHeading
          eyebrow="Net spending accuracy"
          title={
            BigInt(item.amountMinorUnits) > 0n
              ? "Link this refund"
              : "Find a refund for this purchase"
          }
          description="The refund inherits the purchase category so your budget reflects what you actually kept."
        />
      </DialogTitle>
      <DialogContent>
        <Paper variant="outlined" sx={{ p: 3, borderRadius: 3, mb: 3 }}>
          <Typography variant="caption" color="text.secondary">
            Selected {directionLabel(item)}
          </Typography>
          <Typography variant="body2" fontWeight={750} sx={{ mt: 1 }}>
            {candidateLabel(item)}
          </Typography>
        </Paper>
        {candidates.length ? (
          <TextField
            select
            fullWidth
            label={BigInt(item.amountMinorUnits) > 0n ? "Original purchase" : "Refund credit"}
            value={candidateId}
            onChange={(event) => setCandidateId(event.target.value)}
            helperText="Candidates use the same account and currency, opposite direction, and enough unlinked value."
          >
            <MenuItem value="">Choose a transaction</MenuItem>
            {candidates.map((candidate) => (
              <MenuItem key={candidate.id} value={candidate.id}>
                {candidateLabel(candidate)}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <Alert severity="info">No eligible purchase or credit is in the loaded ledger.</Alert>
        )}
        {selected ? (
          <Alert severity="info" sx={{ mt: 3 }}>
            BetterWealth will link only the still-unlinked amount, capped by both sides.
          </Alert>
        ) : null}
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
        <Button variant="contained" disabled={!selected || saving} onClick={() => void submit()}>
          {saving ? "Linking…" : "Confirm refund link"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
