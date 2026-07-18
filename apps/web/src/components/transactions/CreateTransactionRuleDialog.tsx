import {
  Alert,
  Box,
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
} from "@mui/material";
import { useEffect, useState } from "react";
import type { ApiCategory, ApiRule, ApiTransactionDetail } from "../../api";
import { Dialog, Stack, TextField, Typography } from "../mui";
import { DialogHeading } from "./DialogHeading";
import type { RuleCreateInput, RulePreview, TransactionView } from "./types";
import { formatMinorUnits } from "./utils";

export function CreateTransactionRuleDialog({
  open,
  item,
  detail,
  categories,
  onClose,
  onPreview,
  onSubmit,
}: {
  open: boolean;
  item: TransactionView | null;
  detail: ApiTransactionDetail | undefined;
  categories: ApiCategory[];
  onClose: () => void;
  onPreview: (input: Pick<ApiRule, "conditions" | "actions">) => Promise<RulePreview>;
  onSubmit: (input: RuleCreateInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const [operator, setOperator] = useState<"exact" | "contains">("exact");
  const [categoryId, setCategoryId] = useState("");
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [working, setWorking] = useState<"preview" | "save" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !item) return;
    setName(`${item.merchant} → ${item.category}`);
    setPattern(item.rawDescription);
    setOperator("exact");
    setCategoryId(
      detail?.categoryId ?? categories.find(({ name }) => name === item.category)?.id ?? "",
    );
    setPreview(null);
    setError("");
  }, [categories, detail?.categoryId, item, open]);

  if (!item) return null;
  const condition = {
    field: "normalizedDescription",
    operator,
    value: pattern.trim(),
    caseSensitive: false,
  };
  const actions = categoryId ? [{ type: "setCategory", categoryId }] : [];
  const update = (callback: () => void) => {
    callback();
    setPreview(null);
    setError("");
  };
  const runPreview = async () => {
    if (!pattern.trim() || !categoryId) return;
    setWorking("preview");
    setError("");
    try {
      setPreview(await onPreview({ conditions: condition, actions }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The rule preview could not run.");
    } finally {
      setWorking(null);
    }
  };
  const save = async () => {
    if (!preview || !name.trim() || !pattern.trim() || !categoryId) return;
    setWorking("save");
    setError("");
    try {
      await onSubmit({
        name: name.trim(),
        priority: 100,
        enabled: true,
        origin: "user",
        conditions: condition,
        actions,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The rule could not be created.");
    } finally {
      setWorking(null);
    }
  };

  return (
    <Dialog open={open} onClose={working ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle component="div">
        <DialogHeading
          eyebrow="Deterministic automation"
          title="Create a narrow transaction rule"
          description="Preview historical matches first. Saving the rule does not recategorize history."
        />
      </DialogTitle>
      <DialogContent>
        <Stack gap={3}>
          <TextField
            label="Rule name"
            value={name}
            onChange={(event) => update(() => setName(event.target.value))}
            fullWidth
          />
          <Paper variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
            <Typography variant="overline" color="text.secondary">
              When
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} gap={2} sx={{ mt: 2 }}>
              <TextField
                select
                label="Description match"
                value={operator}
                onChange={(event) =>
                  update(() => setOperator(event.target.value as "exact" | "contains"))
                }
                sx={{ minWidth: 150 }}
              >
                <MenuItem value="exact">is exactly</MenuItem>
                <MenuItem value="contains">contains</MenuItem>
              </TextField>
              <TextField
                label="Normalized description pattern"
                value={pattern}
                onChange={(event) => update(() => setPattern(event.target.value))}
                fullWidth
              />
            </Stack>
            {operator === "contains" ? (
              <Alert severity="warning" sx={{ mt: 2 }}>
                Contains rules are broader. Keep this provider-specific text distinctive.
              </Alert>
            ) : null}
          </Paper>
          <Paper variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
            <Typography variant="overline" color="text.secondary">
              Then
            </Typography>
            <TextField
              select
              label="Set category"
              value={categoryId}
              onChange={(event) => update(() => setCategoryId(event.target.value))}
              fullWidth
              sx={{ mt: 2 }}
            >
              <MenuItem value="">Choose a category</MenuItem>
              {categories
                .filter(({ active, kind }) => active && kind !== "transfer")
                .map((category) => (
                  <MenuItem key={category.id} value={category.id}>
                    {category.name}
                  </MenuItem>
                ))}
            </TextField>
          </Paper>
          <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
            <Box>
              <Typography variant="body2" fontWeight={750}>
                Preview before saving
              </Typography>
              <Typography variant="caption" color="text.secondary">
                No transaction changes during preview.
              </Typography>
            </Box>
            <Button
              variant="outlined"
              disabled={!pattern.trim() || !categoryId || Boolean(working)}
              onClick={() => void runPreview()}
            >
              {working === "preview" ? "Checking…" : "Run preview"}
            </Button>
          </Stack>
          {preview ? (
            <Alert severity={preview.conflicts.length ? "warning" : "success"}>
              <strong>
                {preview.matchCount} historical {preview.matchCount === 1 ? "match" : "matches"}
              </strong>
              {` · ${formatMinorUnits(BigInt(preview.aggregateAmount.minorUnits), preview.aggregateAmount.currency)}`}
              {preview.conflicts.length
                ? ` · ${preview.conflicts.length} existing rule conflict${preview.conflicts.length === 1 ? "" : "s"}`
                : " · no existing rule conflicts"}
            </Alert>
          ) : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={Boolean(working)}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={!preview || !name.trim() || Boolean(working)}
          onClick={() => void save()}
        >
          {working === "save" ? "Creating rule…" : "Confirm and create rule"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
