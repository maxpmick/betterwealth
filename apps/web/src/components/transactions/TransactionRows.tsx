import {
  ReceiptLongRounded,
  RemoveCircleOutlineRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import { Box, Button, Paper } from "@mui/material";
import { Checkbox, Stack, Typography } from "../mui";
import { Money, StatusChip } from "../ui";
import type { TransactionView } from "./types";
import { hasSuggestedMatch } from "./utils";

function TransactionBadges({ item }: { item: TransactionView }) {
  const confirmedTransfer = item.transferMatch
    ? item.transferMatch.status === "confirmed"
    : item.isTransfer;
  const suggestedTransfer = item.transferMatch?.status === "suggested";
  const confirmedRefund = item.refundLinkMatches.some(({ status }) => status === "confirmed");
  const suggestedRefund = item.refundLinkMatches.some(({ status }) => status === "suggested");
  return (
    <Stack direction="row" justifyContent="flex-end" gap={1} flexWrap="wrap">
      {item.status === "removed" ? <StatusChip label="Removed" tone="neutral" /> : null}
      {item.status === "void" ? <StatusChip label="Void" tone="neutral" /> : null}
      {item.pending ? <StatusChip label="Pending" tone="warning" /> : null}
      {item.needsReview ? <StatusChip label="Review" tone="warning" /> : null}
      {confirmedTransfer ? <StatusChip label="Transfer" tone="neutral" /> : null}
      {suggestedTransfer ? <StatusChip label="Transfer suggestion" tone="warning" /> : null}
      {item.hasSplits ? <StatusChip label="Split" tone="info" /> : null}
      {confirmedRefund ? <StatusChip label="Refund" tone="positive" /> : null}
      {suggestedRefund ? <StatusChip label="Refund suggestion" tone="warning" /> : null}
      {item.excluded && !item.isTransfer ? <StatusChip label="Excluded" tone="neutral" /> : null}
    </Stack>
  );
}

export function TransactionRow({
  item,
  checked,
  onCheck,
  onOpen,
}: {
  item: TransactionView;
  checked: boolean;
  onCheck: (checked: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns:
          "44px minmax(210px, 1.7fr) minmax(135px, .85fr) minmax(130px, .8fr) minmax(120px, .72fr)",
        gap: 2,
        alignItems: "center",
        minHeight: 68,
        px: 3,
        borderBottom: "1px solid",
        borderColor: "divider",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      {item.status === "removed" ? (
        <RemoveCircleOutlineRounded color="disabled" aria-label="Removed transaction" />
      ) : (
        <Checkbox
          size="small"
          checked={checked}
          onChange={(event) => onCheck(event.target.checked)}
          inputProps={{ "aria-label": `Select ${item.merchant}` }}
        />
      )}
      <Button
        color="inherit"
        onClick={onOpen}
        sx={{ justifyContent: "flex-start", textAlign: "left", p: 0, minHeight: 44, minWidth: 0 }}
      >
        <Box
          sx={{
            width: 38,
            height: 38,
            borderRadius: 1,
            flex: "0 0 auto",
            display: "grid",
            placeItems: "center",
            bgcolor: "action.hover",
            color: item.needsReview || hasSuggestedMatch(item) ? "warning.main" : "text.secondary",
            mr: 2.5,
          }}
        >
          {item.needsReview || hasSuggestedMatch(item) ? (
            <WarningAmberRounded fontSize="small" />
          ) : (
            <ReceiptLongRounded fontSize="small" />
          )}
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" fontWeight={700} noWrap>
            {item.merchant}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {item.rawDescription}
          </Typography>
        </Box>
      </Button>
      <Box>
        <Typography variant="body2" noWrap>
          {item.hasSplits ? "Split transaction" : item.category}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap>
          {item.envelope}
        </Typography>
      </Box>
      <Box>
        <Typography variant="body2" noWrap>
          {item.account}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          ••{item.accountMask.slice(-2)}
        </Typography>
      </Box>
      <Box sx={{ textAlign: "right" }}>
        <Typography variant="body2" fontWeight={700}>
          <Money value={item.amount} currency={item.currency} sign />
        </Typography>
        <TransactionBadges item={item} />
      </Box>
    </Box>
  );
}

export function MobileTransactionRow({
  item,
  checked,
  onCheck,
  onOpen,
}: {
  item: TransactionView;
  checked: boolean;
  onCheck: (checked: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Stack direction="row" gap={2} alignItems="flex-start">
        {item.status === "removed" ? (
          <RemoveCircleOutlineRounded color="disabled" aria-label="Removed transaction" />
        ) : (
          <Checkbox
            size="small"
            checked={checked}
            onChange={(event) => onCheck(event.target.checked)}
            inputProps={{ "aria-label": `Select ${item.merchant}` }}
            sx={{ mt: -1, ml: -1 }}
          />
        )}
        <Button
          color="inherit"
          fullWidth
          onClick={onOpen}
          sx={{
            p: 0,
            minWidth: 0,
            minHeight: 44,
            justifyContent: "space-between",
            textAlign: "left",
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" fontWeight={700} noWrap>
              {item.merchant}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block" }}>
              {item.hasSplits ? "Split transaction" : item.category} · {item.account}
            </Typography>
            <Box sx={{ mt: 1 }}>
              <TransactionBadges item={item} />
            </Box>
          </Box>
          <Typography variant="body2" fontWeight={700} sx={{ ml: 2 }}>
            <Money value={item.amount} currency={item.currency} sign />
          </Typography>
        </Button>
      </Stack>
    </Paper>
  );
}
