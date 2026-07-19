import { ArrowForwardRounded } from "@mui/icons-material";
import { Box, Card, CardContent } from "@mui/material";
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
  status: string;
  statusTone?: "positive" | "warning" | "risk" | "info" | "neutral";
}

export function PlanFlowCard({
  title,
  steps,
  footer,
  testId,
}: {
  title: string;
  steps: readonly PlanFlowStep[];
  footer?: ReactNode;
  testId?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent sx={{ p: { xs: 4, sm: 5 }, "&:last-child": { pb: { xs: 4, sm: 5 } } }}>
        <SectionHeader title={title} />
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
                  borderRadius: 1,
                  color: "text.primary",
                  textDecoration: "none",
                  "&:hover": {
                    bgcolor: "action.hover",
                  },
                }}
              >
                <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2}>
                  <Stack direction="row" alignItems="center" gap={2} sx={{ minWidth: 0 }}>
                    <Box
                      sx={{
                        width: 34,
                        height: 34,
                        borderRadius: 1,
                        display: "grid",
                        placeItems: "center",
                        flex: "0 0 auto",
                        color: "text.secondary",
                        bgcolor: "action.hover",
                        "& > svg": { fontSize: 18 },
                      }}
                    >
                      {step.icon}
                    </Box>
                    <Typography variant="overline" color="text.secondary" noWrap>
                      {String(index + 1).padStart(2, "0")} · {step.label}
                    </Typography>
                  </Stack>
                  <ArrowForwardRounded sx={{ fontSize: 17, color: "text.disabled" }} />
                </Stack>
                <Typography component="div" variant="h6" sx={{ mt: 3 }}>
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
