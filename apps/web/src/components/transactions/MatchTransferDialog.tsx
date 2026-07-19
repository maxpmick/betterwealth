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
import { candidateLabel, directionLabel, formatMinorUnits } from "./utils";

export function MatchTransferDialog({
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
  onSubmit: (input: { outflowTransactionId: string; inflowTransactionId: string }) => Promise<void>;
}) {
  const [candidateId, setCandidateId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const candidates = useMemo(() => {
    if (!item) return [];
    const currentAmount = BigInt(item.amountMinorUnits);
    return transactions.filter(
      (candidate) =>
        candidate.id !== item.id &&
        candidate.currency === item.currency &&
        BigInt(candidate.amountMinorUnits) === -currentAmount &&
        candidate.accountId !== item.accountId &&
        !candidate.transferId,
    );
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
    const currentIsOutflow = BigInt(item.amountMinorUnits) < 0n;
    setSaving(true);
    setError("");
    try {
      await onSubmit({
        outflowTransactionId: currentIsOutflow ? item.id : selected.id,
        inflowTransactionId: currentIsOutflow ? selected.id : item.id,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The transfer could not be matched.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle component="div">
        <DialogHeading
          eyebrow="Cash flow cleanup"
          title="Match both sides of a transfer"
          description="Matched transfers stay visible but leave spending and income reports."
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
            label="Matching transaction"
            value={candidateId}
            onChange={(event) => setCandidateId(event.target.value)}
            helperText="Only an exact, opposite amount in the same currency and a different account can match."
          >
            <MenuItem value="">Choose the other side</MenuItem>
            {candidates.map((candidate) => (
              <MenuItem key={candidate.id} value={candidate.id}>
                {candidateLabel(candidate)}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <Alert severity="info">
            No unmatched exact opposite was found. Sync the receiving account, then try again.
          </Alert>
        )}
        {selected ? (
          <Alert severity="success" sx={{ mt: 3 }}>
            Exact{" "}
            {formatMinorUnits(
              BigInt(item.amountMinorUnits) < 0n
                ? -BigInt(item.amountMinorUnits)
                : BigInt(item.amountMinorUnits),
              item.currency,
            )}{" "}
            pair found. Both entries will be excluded from spending.
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
          {saving ? "Matching…" : "Confirm transfer match"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
