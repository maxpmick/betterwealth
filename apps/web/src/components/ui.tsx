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
  alpha,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  LinearProgress,
  Skeleton,
  Tooltip,
  useTheme,
} from "@mui/material";
import { format } from "date-fns";
import type { ReactNode } from "react";
import type { TrustState } from "../api";
import { usePrivacy } from "../contexts";
import { Stack, Typography } from "./mui";

export function formatMoney(value: number, currency = "USD", compact = false) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : Number.isInteger(value) ? 0 : 2,
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
      <Box
        component="span"
        aria-label="Amount hidden"
        sx={{ fontVariantNumeric: "tabular-nums", letterSpacing: "0.08em" }}
      >
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

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      justifyContent="space-between"
      alignItems={{ xs: "stretch", sm: "flex-end" }}
      gap={3}
    >
      <Box sx={{ maxWidth: 720 }}>
        {eyebrow ? (
          <Typography variant="overline" color="secondary.main">
            {eyebrow}
          </Typography>
        ) : null}
        <Typography component="h1" variant="h1">
          {title}
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          {description}
        </Typography>
      </Box>
      {actions ? (
        <Stack direction="row" gap={2} flexWrap="wrap">
          {actions}
        </Stack>
      ) : null}
    </Stack>
  );
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={2}>
      <Box>
        <Typography component="h2" variant="h3">
          {title}
        </Typography>
        {description ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {description}
          </Typography>
        ) : null}
      </Box>
      {action}
    </Stack>
  );
}

export function StatusChip({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "positive" | "warning" | "risk" | "info" | "neutral";
}) {
  const palette = {
    positive: { light: "#075C40", dark: "#79DDB8", base: "#1F9D72", opacity: 0.12 },
    warning: { light: "#7A4307", dark: "#F2BA72", base: "#D98B2B", opacity: 0.14 },
    risk: { light: "#8E2D29", dark: "#F29A94", base: "#DD625B", opacity: 0.13 },
    info: { light: "#244F86", dark: "#9CC2F2", base: "#4A7FD1", opacity: 0.13 },
    neutral: { light: "#46505C", dark: "#CBD3DF", base: "#687786", opacity: 0.12 },
  }[tone];
  return (
    <Chip
      size="small"
      label={label}
      sx={(theme) => ({
        color: theme.palette.mode === "dark" ? palette.dark : palette.light,
        bgcolor: alpha(palette.base, palette.opacity),
        fontWeight: 650,
      })}
    />
  );
}

export function MetricCard({
  label,
  value,
  helper,
  trend,
  tone = "default",
  icon,
}: {
  label: string;
  value: ReactNode;
  helper: string;
  trend?: number;
  tone?: "default" | "gradient";
  icon?: ReactNode;
}) {
  const isGradient = tone === "gradient";
  return (
    <Card
      sx={
        isGradient
          ? {
              color: "#fff",
              border: 0,
              background: "linear-gradient(125deg, #1C3558 0%, #245B67 54%, #1A8A69 115%)",
              boxShadow: "0 24px 58px rgba(27,72,82,0.25)",
            }
          : undefined
      }
    >
      <CardContent sx={{ p: { xs: 4, sm: 5 }, "&:last-child": { pb: { xs: 4, sm: 5 } } }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
          <Typography
            variant="body2"
            sx={{
              color: isGradient ? "rgba(255,255,255,0.78)" : "text.secondary",
              fontWeight: 650,
            }}
          >
            {label}
          </Typography>
          {icon}
        </Stack>
        <Typography
          component="p"
          sx={{
            mt: 2,
            fontSize: { xs: "1.65rem", sm: "2rem" },
            lineHeight: 1.12,
            fontWeight: 740,
            letterSpacing: "-0.035em",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </Typography>
        <Stack direction="row" alignItems="center" gap={1} sx={{ mt: 2 }}>
          {typeof trend === "number" ? (
            <Box
              sx={{
                display: "inline-flex",
                alignItems: "center",
                color: isGradient
                  ? "rgba(255,255,255,0.86)"
                  : trend >= 0
                    ? "success.main"
                    : "error.main",
                fontWeight: 700,
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
          <Typography
            variant="caption"
            sx={{ color: isGradient ? "rgba(255,255,255,0.72)" : "text.secondary" }}
          >
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
        p: 3.5,
        borderRadius: 3,
        bgcolor: "action.hover",
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
  color = "secondary.main",
  label,
}: {
  value: number;
  color?: string;
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <Box>
      <LinearProgress
        variant="determinate"
        value={clamped}
        aria-label={label}
        sx={{ bgcolor: "action.hover", "& .MuiLinearProgress-bar": { bgcolor: color } }}
      />
    </Box>
  );
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
      <CardContent sx={{ p: 5 }}>
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
    <Stack alignItems="center" textAlign="center" sx={{ py: 9, px: 4 }}>
      <Box
        sx={{
          width: 52,
          height: 52,
          borderRadius: 3,
          bgcolor: "action.hover",
          display: "grid",
          placeItems: "center",
          color: "text.secondary",
        }}
      >
        {icon}
      </Box>
      <Typography variant="h3" sx={{ mt: 3 }}>
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
  const theme = useTheme();
  return (
    <Box
      aria-label="Chart values hidden"
      sx={{
        height: 250,
        display: "grid",
        placeItems: "center",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <Box
        aria-hidden
        sx={{
          position: "absolute",
          inset: 16,
          opacity: 0.38,
          background: `linear-gradient(155deg, transparent 0 25%, ${alpha(theme.palette.secondary.main, 0.3)} 26% 30%, transparent 31% 44%, ${alpha(theme.palette.primary.main, 0.25)} 45% 49%, transparent 50%)`,
          filter: "blur(8px)",
        }}
      />
      <Stack alignItems="center" sx={{ zIndex: 1 }}>
        <Typography variant="subtitle1">Values hidden</Typography>
        <Typography variant="caption" color="text.secondary">
          Turn off privacy mode to explore this chart.
        </Typography>
      </Stack>
    </Box>
  );
}
