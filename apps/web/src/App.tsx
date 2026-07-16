import { ArrowBackRounded, SearchOffRounded } from "@mui/icons-material";
import { Box, Button, LinearProgress } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api } from "./api";
import { AppShell } from "./components/AppShell";
import { Stack, Typography } from "./components/mui";
import { isDemoMode } from "./demo";
import { BudgetPage } from "./pages/BudgetPage";
import { TodayPage } from "./pages/TodayPage";
import { TransactionsPage } from "./pages/TransactionsPage";

const LoginPage = lazy(() =>
  import("./pages/AuthPages").then((module) => ({ default: module.LoginPage })),
);
const RegisterPage = lazy(() =>
  import("./pages/AuthPages").then((module) => ({ default: module.RegisterPage })),
);

const OnboardingPage = lazy(() =>
  import("./pages/OnboardingPage").then((module) => ({ default: module.OnboardingPage })),
);
const NetWorthPage = lazy(() =>
  import("./pages/WealthPages").then((module) => ({ default: module.NetWorthPage })),
);
const GoalsPage = lazy(() =>
  import("./pages/WealthPages").then((module) => ({ default: module.GoalsPage })),
);
const ForecastPage = lazy(() =>
  import("./pages/ForecastPage").then((module) => ({ default: module.ForecastPage })),
);
const AccountsPage = lazy(() =>
  import("./pages/AccountsPage").then((module) => ({ default: module.AccountsPage })),
);
const AutomationPage = lazy(() =>
  import("./pages/AutomationPage").then((module) => ({ default: module.AutomationPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })),
);

function RouteLoading() {
  return (
    <Box
      role="status"
      aria-label="Loading page"
      sx={{ minHeight: "100vh", bgcolor: "background.default" }}
    >
      <LinearProgress />
    </Box>
  );
}

function ProtectedAppShell() {
  const demo = isDemoMode();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: api.session,
    enabled: !demo,
    retry: false,
    staleTime: 60_000,
  });
  if (!demo && session.isPending)
    return (
      <Box
        role="status"
        aria-label="Checking session"
        sx={{ minHeight: "100vh", bgcolor: "background.default" }}
      >
        <LinearProgress />
      </Box>
    );
  if (!demo && session.isError) return <Navigate to="/login" replace />;
  return <AppShell />;
}

function ProtectedOnboarding() {
  const demo = isDemoMode();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: api.session,
    enabled: !demo,
    retry: false,
    staleTime: 60_000,
  });
  if (!demo && session.isPending) return <RouteLoading />;
  if (!demo && session.isError) return <Navigate to="/login" replace />;
  return <OnboardingPage />;
}

function SessionAwareRoot() {
  const demo = isDemoMode();
  const session = useQuery({
    queryKey: ["session"],
    queryFn: api.session,
    enabled: !demo,
    retry: false,
    staleTime: 60_000,
  });
  if (demo) return <Navigate to="/today" replace />;
  if (session.isPending) return <RouteLoading />;
  return <Navigate to={session.isError ? "/login" : "/today"} replace />;
}

function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <Stack alignItems="center" textAlign="center" sx={{ py: 18 }}>
      <Box
        sx={{
          width: 60,
          height: 60,
          borderRadius: 4,
          display: "grid",
          placeItems: "center",
          bgcolor: "action.hover",
          color: "text.secondary",
        }}
      >
        <SearchOffRounded />
      </Box>
      <Typography component="h1" variant="h1" sx={{ mt: 4 }}>
        That page isn’t in the plan
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 2, maxWidth: 460 }}>
        The link may be out of date. Your financial data has not been changed.
      </Typography>
      <Button
        variant="contained"
        startIcon={<ArrowBackRounded />}
        onClick={() => navigate("/today")}
        sx={{ mt: 5 }}
      >
        Back to Today
      </Button>
    </Stack>
  );
}

export function AppRoutes() {
  return (
    <>
      <Box
        component="a"
        href="#main-content"
        sx={{
          position: "fixed",
          top: -100,
          left: 12,
          zIndex: 2000,
          bgcolor: "background.paper",
          color: "text.primary",
          px: 4,
          py: 2,
          borderRadius: 2,
          boxShadow: 4,
          "&:focus": { top: 12 },
        }}
      >
        Skip to main content
      </Box>
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/onboarding" element={<ProtectedOnboarding />} />
          <Route element={<ProtectedAppShell />}>
            <Route path="/today" element={<TodayPage />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            <Route path="/budget" element={<BudgetPage />} />
            <Route path="/net-worth" element={<NetWorthPage />} />
            <Route path="/goals" element={<GoalsPage />} />
            <Route path="/forecast" element={<ForecastPage />} />
            <Route path="/accounts" element={<AccountsPage />} />
            <Route path="/automation" element={<AutomationPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          <Route path="/" element={<SessionAwareRoot />} />
        </Routes>
      </Suspense>
    </>
  );
}
