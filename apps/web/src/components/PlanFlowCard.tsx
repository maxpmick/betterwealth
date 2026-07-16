import { ArrowForwardRounded } from "@mui/icons-material";
import { alpha, Box, Card, CardContent } from "@mui/material";
import type { ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Stack, Typography } from "./mui";
import { SectionHeader, StatusChip } from "./ui";

export interface PlanFlowStep {
  id: string;
  label: string;
  value: ReactNode;
  detail: ReactNode;
  icon: ReactNode;
  to: string;
  tone: string;
  status: string;
  statusTone?: "positive" | "warning" | "risk" | "info" | "neutral";
}

export function PlanFlowCard({
  title,
  description,
  steps,
  footer,
  testId,
}: {
  title: string;
  description: string;
  steps: readonly PlanFlowStep[];
  footer?: ReactNode;
  testId?: string;
}) {
  return (
    <Card
      data-testid={testId}
      sx={{
        overflow: "hidden",
        position: "relative",
        background: (theme) =>
          `radial-gradient(circle at 92% 5%, ${alpha(theme.palette.secondary.main, 0.09)}, transparent 34%), ${theme.palette.background.paper}`,
      }}
    >
      <CardContent sx={{ p: { xs: 4, sm: 5 }, "&:last-child": { pb: { xs: 4, sm: 5 } } }}>
        <SectionHeader title={title} description={description} />
        <Box
          role="list"
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "1fr",
              sm: "repeat(2, 1fr)",
              lg: `repeat(${steps.length}, 1fr)`,
            },
            gap: 2.5,
            mt: 5,
          }}
        >
          {steps.map((step, index) => (
            <Box
              key={step.id}
              role="listitem"
              sx={{
                minWidth: 0,
              }}
            >
              <Box
                component={RouterLink}
                to={step.to}
                sx={{
                  display: "block",
                  height: "100%",
                  p: 3.5,
                  border: "1px solid",
                  borderColor: "divider",
                  borderRadius: 3,
                  color: "text.primary",
                  textDecoration: "none",
                  bgcolor: (theme) => alpha(theme.palette.background.paper, 0.66),
                  transition:
                    "transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease",
                  "&:hover": {
                    transform: "translateY(-2px)",
                    borderColor: alpha(step.tone, 0.42),
                    boxShadow: `0 12px 28px ${alpha(step.tone, 0.1)}`,
                  },
                }}
              >
                <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
                  <Stack direction="row" alignItems="center" gap={2} sx={{ minWidth: 0 }}>
                    <Box
                      sx={{
                        width: 34,
                        height: 34,
                        borderRadius: 2.25,
                        display: "grid",
                        placeItems: "center",
                        flex: "0 0 auto",
                        color: step.tone,
                        bgcolor: alpha(step.tone, 0.12),
                        "& > svg": { fontSize: 18 },
                      }}
                    >
                      {step.icon}
                    </Box>
                    <Typography
                      variant="overline"
                      color="text.secondary"
                      noWrap
                      sx={{ letterSpacing: "0.055em" }}
                    >
                      {String(index + 1).padStart(2, "0")} · {step.label}
                    </Typography>
                  </Stack>
                  <ArrowForwardRounded sx={{ fontSize: 17, color: "text.disabled" }} />
                </Stack>
                <Typography
                  component="div"
                  sx={{
                    mt: 3,
                    fontSize: { xs: "1.25rem", sm: "1.35rem" },
                    lineHeight: 1.15,
                    fontWeight: 750,
                    letterSpacing: "-0.025em",
                  }}
                >
                  {step.value}
                </Typography>
                <Typography
                  component="div"
                  variant="caption"
                  color="text.secondary"
                  sx={{ mt: 1.25, minHeight: { lg: 34 } }}
                >
                  {step.detail}
                </Typography>
                <Box sx={{ mt: 2.5 }}>
                  <StatusChip label={step.status} tone={step.statusTone ?? "neutral"} />
                </Box>
              </Box>
            </Box>
          ))}
        </Box>
        {footer ? (
          <Box
            sx={{
              mt: 3,
              pt: 3,
              borderTop: "1px solid",
              borderColor: "divider",
            }}
          >
            {footer}
          </Box>
        ) : null}
      </CardContent>
    </Card>
  );
}
