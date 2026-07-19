import {
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  CheckCircleRounded,
  HelpOutlineRounded,
  InfoOutlined,
  RefreshRounded,
  WarningAmberRounded,
} from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  LinearProgress,
  Skeleton,
  Tooltip,
} from "@mui/material";
import { format } from "date-fns";
import type { ReactNode } from "react";
import type { TrustState } from "../api";
import { usePrivacy } from "../contexts";
import { fractionDigitsFor } from "../lib/money";
import { Stack, Typography } from "./mui";

export function formatMoney(value: number, currency = "USD", compact = false) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : fractionDigitsFor(currency),
    minimumFractionDigits: compact ? 0 : Number.isInteger(value) ? 0 : undefined,
  }).format(value);
}

export function Money({
  value,
  currency = "USD",
  compact = false,
  sign = false,
}: {
  value: number;
  currency?: string;
  compact?: boolean;
  sign?: boolean;
}) {
  const { privacyEnabled } = usePrivacy();
  if (privacyEnabled) {
    return (
      <Box component="span" aria-label="Amount hidden" sx={{ fontVariantNumeric: "tabular-nums" }}>
        ••••
      </Box>
    );
  }
  const text = formatMoney(Math.abs(value), currency, compact);
  return (
    <Box component="span" sx={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
      {sign && value > 0 ? "+" : value < 0 ? "−" : ""}
      {text}
    </Box>
  );
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      justifyContent="space-between"
      alignItems={{ xs: "stretch", sm: "center" }}
      gap={3}
    >
      <Typography component="h1" variant="h4">
        {title}
      </Typography>
      {actions ? (
        <Stack direction="row" gap={2} flexWrap="wrap">
          {actions}
        </Stack>
      ) : null}
    </Stack>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
      <Typography component="h2" variant="h6">
        {title}
      </Typography>
      {action}
    </Stack>
  );
}

const statusChipColors = {
  positive: "success",
  warning: "warning",
  risk: "error",
  info: "info",
  neutral: "default",
} as const;

export function StatusChip({
  label,
  tone = "neutral",
}: {
  label: ReactNode;
  tone?: "positive" | "warning" | "risk" | "info" | "neutral";
}) {
  const color = statusChipColors[tone];
  if (color === "default") {
    return <Chip size="small" label={label} />;
  }
  // MUI's color chips fail WCAG contrast for small labels (even warning.dark is
  // 3.78:1), so the label keeps the default text color and the tone shows in
  // the border, which contrast rules do not cover.
  return (
    <Chip
      size="small"
      label={label}
      variant="outlined"
      sx={(theme) => ({
        borderColor: theme.palette.mode === "light" ? `${color}.main` : `${color}.light`,
      })}
    />
  );
}

export function MetricCard({
  label,
  value,
  helper,
  trend,
  icon,
}: {
  label: string;
  value: ReactNode;
  helper: string;
  trend?: number;
  icon?: ReactNode;
}) {
  return (
    <Card>
      <CardContent sx={{ p: 4, "&:last-child": { pb: 4 } }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
          <Typography variant="body2" color="text.secondary">
            {label}
          </Typography>
          {icon}
        </Stack>
        <Typography component="p" variant="h5" sx={{ mt: 2, fontVariantNumeric: "tabular-nums" }}>
          {value}
        </Typography>
        <Stack direction="row" alignItems="center" gap={1} sx={{ mt: 1 }}>
          {typeof trend === "number" ? (
            <Box
              sx={{
                display: "inline-flex",
                alignItems: "center",
                color: trend >= 0 ? "success.main" : "error.main",
                fontSize: 12,
              }}
            >
              {trend >= 0 ? (
                <ArrowUpwardRounded sx={{ fontSize: 15 }} />
              ) : (
                <ArrowDownwardRounded sx={{ fontSize: 15 }} />
              )}
              {Math.abs(trend)}%
            </Box>
          ) : null}
          <Typography variant="caption" color="text.secondary">
            {helper}
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}

const trustCopy: Record<
  TrustState,
  { label: string; tone: "positive" | "warning" | "risk"; icon: ReactNode; title: string }
> = {
  ready: {
    label: "Ready",
    tone: "positive",
    icon: <CheckCircleRounded />,
    title: "This number is ready to use",
  },
  incomplete: {
    label: "Incomplete",
    tone: "warning",
    icon: <InfoOutlined />,
    title: "A useful estimate with missing inputs",
  },
  stale: {
    label: "Stale",
    tone: "risk",
    icon: <WarningAmberRounded />,
    title: "Refresh before relying on this amount",
  },
};

export function TrustStatePanel({
  state,
  asOf,
  pendingImpact,
  missingInputs = [],
  onCorrect,
}: {
  state: TrustState;
  asOf: string;
  pendingImpact: number;
  missingInputs?: string[];
  onCorrect?: () => void;
}) {
  const config = trustCopy[state];
  return (
    <Box
      data-testid="trust-state"
      data-state={state}
      sx={{
        p: 4,
        borderRadius: 1,
        border: "1px solid",
        borderColor: "divider",
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
        <Stack direction="row" alignItems="center" gap={1.5}>
          <Box
            sx={{
              display: "flex",
              color:
                state === "ready"
                  ? "success.main"
                  : state === "incomplete"
                    ? "warning.main"
                    : "error.main",
              "& svg": { fontSize: 20 },
            }}
          >
            {config.icon}
          </Box>
          <Typography variant="subtitle1">{config.title}</Typography>
        </Stack>
        <StatusChip label={config.label} tone={config.tone} />
      </Stack>
      <Stack direction={{ xs: "column", sm: "row" }} gap={{ xs: 1, sm: 4 }} sx={{ mt: 2 }}>
        <Typography variant="caption" color="text.secondary">
          As of {asOf}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Pending impact <Money value={pendingImpact} sign />
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Confidence {state === "ready" ? "high" : state === "incomplete" ? "medium" : "low"}
        </Typography>
      </Stack>
      {missingInputs.length ? (
        <Typography variant="body2" sx={{ mt: 2 }}>
          Missing: {missingInputs.join(", ")}.
        </Typography>
      ) : null}
      {state !== "ready" && onCorrect ? (
        <Button size="small" startIcon={<RefreshRounded />} onClick={onCorrect} sx={{ mt: 2 }}>
          Correct now
        </Button>
      ) : null}
    </Box>
  );
}

export function ProgressMeter({
  value,
  color = "primary",
  label,
}: {
  value: number;
  color?: "primary" | "secondary" | "success" | "warning" | "error" | "info";
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return <LinearProgress variant="determinate" value={clamped} color={color} aria-label={label} />;
}

export function HelpTip({ title }: { title: string }) {
  return (
    <Tooltip title={title}>
      <Box
        component="span"
        tabIndex={0}
        role="img"
        aria-label={title}
        sx={{ display: "inline-flex", color: "text.secondary" }}
      >
        <HelpOutlineRounded sx={{ fontSize: 17 }} />
      </Box>
    </Tooltip>
  );
}

export function LoadingCard({ rows = 3 }: { rows?: number }) {
  return (
    <Card aria-label="Loading content">
      <CardContent sx={{ p: 4 }}>
        <Stack gap={2}>
          <Skeleton width="38%" />
          <Skeleton variant="rounded" height={92} />
          {Array.from({ length: rows }).map((_, index) => (
            <Skeleton key={index} width={`${90 - index * 8}%`} />
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}

export function InlineLoading({ label = "Loading" }: { label?: string }) {
  return (
    <Stack direction="row" alignItems="center" gap={2} role="status">
      <CircularProgress size={18} />
      <Typography variant="body2">{label}</Typography>
    </Stack>
  );
}

export function ErrorState({
  title = "We could not load this",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Alert
      severity="error"
      variant="outlined"
      action={
        onRetry ? (
          <Button color="inherit" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    >
      <Typography variant="subtitle1">{title}</Typography>
      <Typography variant="body2">{message}</Typography>
    </Alert>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <Stack alignItems="center" textAlign="center" sx={{ py: 8, px: 4 }}>
      <Box
        sx={{
          width: 52,
          height: 52,
          borderRadius: 1,
          bgcolor: "action.hover",
          display: "grid",
          placeItems: "center",
          color: "text.secondary",
        }}
      >
        {icon}
      </Box>
      <Typography variant="h6" sx={{ mt: 3 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: 380 }}>
        {description}
      </Typography>
      <Button variant="outlined" onClick={onAction} sx={{ mt: 3 }}>
        {actionLabel}
      </Button>
    </Stack>
  );
}

export function DateLabel({ value }: { value: string | Date }) {
  return <>{format(typeof value === "string" ? new Date(value) : value, "MMM d, yyyy")}</>;
}

export function ChartMaskedState() {
  return (
    <Box
      aria-label="Chart values hidden"
      sx={{ height: 250, display: "grid", placeItems: "center" }}
    >
      <Stack alignItems="center">
        <Typography variant="subtitle1">Values hidden</Typography>
        <Typography variant="caption" color="text.secondary">
          Turn off privacy mode to explore this chart.
        </Typography>
      </Stack>
    </Box>
  );
}
