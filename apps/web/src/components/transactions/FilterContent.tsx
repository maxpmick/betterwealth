import { Box, Chip, InputAdornment } from "@mui/material";
import { Stack, TextField, Typography } from "../mui";
import type { LedgerRangeFilters } from "./types";

export function FilterContent({
  selected,
  setSelected,
  range,
  setRange,
}: {
  selected: string[];
  setSelected: (filters: string[]) => void;
  range: LedgerRangeFilters;
  setRange: (filters: LedgerRangeFilters) => void;
}) {
  const groups = [
    ["Status", ["Needs review", "Suggested match", "Pending", "Posted", "Removed", "Excluded"]],
    ["Type", ["Income", "Expense", "Transfer", "Refund", "Recurring"]],
    ["Source", ["SimpleFIN", "Manual", "CSV import"]],
  ];
  const toggle = (value: string) =>
    setSelected(
      selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value],
    );
  return (
    <Stack gap={5}>
      {groups.map(([label, values]) => (
        <Box key={String(label)}>
          <Typography variant="overline" color="text.secondary">
            {label}
          </Typography>
          <Stack direction="row" flexWrap="wrap" gap={2} sx={{ mt: 2 }}>
            {(values as string[]).map((value) => (
              <Chip
                key={value}
                clickable
                label={value}
                color={selected.includes(value) ? "primary" : "default"}
                variant={selected.includes(value) ? "filled" : "outlined"}
                onClick={() => toggle(value)}
              />
            ))}
          </Stack>
        </Box>
      ))}
      <Box>
        <Typography variant="overline" color="text.secondary">
          Absolute amount
        </Typography>
        <Stack direction="row" gap={2} sx={{ mt: 2 }}>
          <TextField
            label="Minimum"
            type="number"
            value={range.minimum}
            onChange={(event) => setRange({ ...range, minimum: event.target.value })}
            inputProps={{ min: 0, step: "0.01" }}
            InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
          />
          <TextField
            label="Maximum"
            type="number"
            value={range.maximum}
            onChange={(event) => setRange({ ...range, maximum: event.target.value })}
            inputProps={{ min: 0, step: "0.01" }}
            InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
          />
        </Stack>
      </Box>
      <Box>
        <Typography variant="overline" color="text.secondary">
          Effective date
        </Typography>
        <Stack direction="row" gap={2} sx={{ mt: 2 }}>
          <TextField
            label="From"
            type="date"
            value={range.fromDate}
            onChange={(event) => setRange({ ...range, fromDate: event.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            label="To"
            type="date"
            value={range.toDate}
            onChange={(event) => setRange({ ...range, toDate: event.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
          />
        </Stack>
      </Box>
    </Stack>
  );
}
