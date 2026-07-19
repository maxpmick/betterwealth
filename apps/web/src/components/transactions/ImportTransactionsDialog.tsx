import { UploadFileRounded } from "@mui/icons-material";
import {
  Alert,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
} from "@mui/material";
import { useEffect, useState } from "react";
import type { ApiAccount, ApiTransactionImportResult } from "../../api";
import { Dialog, Stack, TextField, Typography } from "../mui";
import { DialogHeading } from "./DialogHeading";
import { estimatedImportRecords } from "./utils";

export function ImportTransactionsDialog({
  open,
  accounts,
  onClose,
  onSubmit,
}: {
  open: boolean;
  accounts: ApiAccount[];
  onClose: () => void;
  onSubmit: (input: {
    accountId: string;
    filename: string;
    content: string;
    currency: string;
  }) => Promise<ApiTransactionImportResult>;
}) {
  const [accountId, setAccountId] = useState("");
  const [filename, setFilename] = useState("");
  const [content, setContent] = useState("");
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ApiTransactionImportResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setAccountId(accounts[0]?.id ?? "");
    setFilename("");
    setContent("");
    setError("");
    setResult(null);
  }, [accounts, open]);

  const account = accounts.find(({ id }) => id === accountId);
  const estimate = filename && content ? estimatedImportRecords(filename, content) : 0;
  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    setError("");
    setResult(null);
    try {
      if (!/\.(csv|ofx|qfx)$/i.test(file.name)) {
        throw new Error("Choose a CSV, OFX, or QFX transaction file.");
      }
      if (file.size > 10 * 1024 * 1024)
        throw new Error("The import file must be 10 MB or smaller.");
      setFilename(file.name);
      setContent(await file.text());
    } catch (caught) {
      setFilename("");
      setContent("");
      setError(caught instanceof Error ? caught.message : "The file could not be read.");
    } finally {
      setReading(false);
    }
  };
  const submit = async () => {
    if (!account || !filename || !content) return;
    setSaving(true);
    setError("");
    try {
      setResult(
        await onSubmit({
          accountId: account.id,
          filename,
          content,
          currency: account.balance.currency,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The file could not be imported.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle component="div">
        <DialogHeading title="Import transactions" />
      </DialogTitle>
      <DialogContent>
        <Stack gap={3}>
          {!accounts.length ? (
            <Alert severity="warning">Add an account before importing its transactions.</Alert>
          ) : null}
          <TextField
            select
            label="Import into account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            fullWidth
            disabled={Boolean(result)}
          >
            {accounts.map((option) => (
              <MenuItem key={option.id} value={option.id}>
                {option.name} · {option.balance.currency}
              </MenuItem>
            ))}
          </TextField>
          <Paper
            variant="outlined"
            sx={{
              p: 4,
              borderStyle: "dashed",
              textAlign: "center",
              bgcolor: "action.hover",
            }}
          >
            <UploadFileRounded color="action" sx={{ fontSize: 34 }} />
            <Typography variant="body2" fontWeight={700} sx={{ mt: 1 }}>
              {filename || "Choose a bank export"}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
              {filename
                ? `${estimate} estimated transaction rows · ${(new Blob([content]).size / 1024).toFixed(1)} KB`
                : "Up to 10 MB · .csv, .ofx, or .qfx"}
            </Typography>
            <Button
              component="label"
              variant="outlined"
              disabled={reading || Boolean(result)}
              sx={{ mt: 3 }}
            >
              {reading ? "Reading file…" : filename ? "Choose another file" : "Choose file"}
              <input
                hidden
                type="file"
                accept=".csv,.ofx,.qfx,text/csv,application/x-ofx"
                aria-label="Transaction import file"
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
            </Button>
          </Paper>
          {filename && !result ? (
            <Alert severity="info">
              Import commits accepted rows immediately; duplicates are skipped.
            </Alert>
          ) : null}
          {result ? (
            <Alert severity="success">
              <strong>{result.importedRecords} imported</strong> · {result.duplicateRecords}{" "}
              duplicates skipped · {result.rejectedRecords} rejected · {result.totalRecords} total
            </Alert>
          ) : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          {result ? "Done" : "Cancel"}
        </Button>
        {!result ? (
          <Button
            variant="contained"
            disabled={!account || !content || saving || reading}
            onClick={() => void submit()}
          >
            {saving ? "Importing…" : `Import ${estimate || "file"}`}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
