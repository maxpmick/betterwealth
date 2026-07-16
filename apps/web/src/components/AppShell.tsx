import {
  AccountBalanceRounded,
  AddRounded,
  AutoAwesomeRounded,
  BoltRounded,
  CategoryRounded,
  CloseRounded,
  DarkModeRounded,
  DashboardRounded,
  FlagRounded,
  KeyboardCommandKeyRounded,
  LightModeRounded,
  LockOutlineRounded,
  LogoutRounded,
  MoreHorizRounded,
  PaymentsRounded,
  ReceiptLongRounded,
  SavingsRounded,
  SearchRounded,
  SettingsRounded,
  SyncRounded,
  TimelineRounded,
  VisibilityOffRounded,
  VisibilityRounded,
} from "@mui/icons-material";
import {
  Alert,
  Avatar,
  alpha,
  Badge,
  BottomNavigation,
  BottomNavigationAction,
  Box,
  Button,
  Chip,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  MenuItem,
  Snackbar,
  Tooltip,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAppearance, usePrivacy } from "../contexts";
import { isDemoMode } from "../demo";
import { Dialog, Drawer, ListItemText, Menu, Stack, TextField, Typography } from "./mui";

interface NavigationItem {
  label: string;
  path: string;
  icon: typeof DashboardRounded;
  badge?: number;
}

const navigation: NavigationItem[] = [
  { label: "Today", path: "/today", icon: DashboardRounded },
  { label: "Transactions", path: "/transactions", icon: ReceiptLongRounded },
  { label: "Budget", path: "/budget", icon: PaymentsRounded },
  { label: "Net worth", path: "/net-worth", icon: SavingsRounded },
  { label: "Goals", path: "/goals", icon: FlagRounded },
  { label: "Forecast", path: "/forecast", icon: TimelineRounded },
  { label: "Accounts", path: "/accounts", icon: AccountBalanceRounded },
  { label: "Automation", path: "/automation", icon: AutoAwesomeRounded },
  { label: "Settings", path: "/settings", icon: SettingsRounded },
];

const mobilePrimary = navigation.filter((item) =>
  ["Today", "Transactions", "Budget", "Goals"].includes(item.label),
);
const mobileMore = navigation.filter((item) =>
  ["Net worth", "Forecast", "Accounts", "Automation", "Settings"].includes(item.label),
);

const quickActions = [
  { label: "Add transaction", icon: ReceiptLongRounded, path: "/transactions?action=add" },
  { label: "Add asset or account", icon: AccountBalanceRounded, path: "/accounts?action=add" },
  { label: "Add goal", icon: FlagRounded, path: "/goals?action=add" },
  { label: "Add envelope", icon: CategoryRounded, path: "/budget?action=add-envelope" },
  { label: "Add automation rule", icon: BoltRounded, path: "/automation?action=add" },
];

const commands = [
  { label: "Review transactions", path: "/transactions?review=true", group: "Actions" },
  { label: "Open paycheck budget", path: "/budget", group: "Planning" },
  { label: "Manage savings goals", path: "/goals", group: "Planning" },
  { label: "View accounts and assets", path: "/accounts", group: "Ledger" },
  { label: "Compare forecast scenarios", path: "/forecast", group: "Planning" },
  { label: "SimpleFIN connection", path: "/settings?section=integrations", group: "Settings" },
];

function Wordmark() {
  return (
    <Stack direction="row" alignItems="center" gap={2}>
      <Box
        aria-hidden
        sx={{
          width: 32,
          height: 32,
          borderRadius: 2.5,
          display: "grid",
          placeItems: "center",
          color: "#fff",
          fontWeight: 800,
          background: "linear-gradient(140deg, #1F3A5F, #1F9D72)",
          boxShadow: "0 8px 18px rgba(31,157,114,0.2)",
        }}
      >
        B
      </Box>
      <Typography sx={{ fontSize: 16, fontWeight: 760, letterSpacing: "-0.025em" }}>
        BetterWealth
      </Typography>
    </Stack>
  );
}

function DesktopRail({ onExit, exiting }: { onExit: () => void; exiting: boolean }) {
  const demo = isDemoMode();
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: api.profile,
    enabled: !demo,
    retry: false,
    initialData: demo
      ? {
          user: {
            id: "demo",
            email: "alex@example.com",
            displayName: "Alex",
            birthDate: null,
            targetAge: 30,
            emailVerifiedAt: null,
          },
          household: {
            id: "demo",
            name: "Alex's household",
            baseCurrency: "USD",
            locale: "en-US",
            timezone: "America/New_York",
          },
          role: "owner" as const,
        }
      : undefined,
  });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    enabled: !demo,
    retry: false,
    initialData: demo
      ? {
          status: "ok" as const,
          version: "0.1.0",
          time: new Date().toISOString(),
          database: "ready" as const,
        }
      : undefined,
  });
  const displayName =
    profile.data?.user.displayName || profile.data?.user.email || "Household member";
  const initial = displayName.trim().charAt(0).toUpperCase() || "B";
  const runtimeLabel = health.isPending
    ? "Checking local API"
    : health.isError
      ? "API needs attention"
      : "API and database ready";
  return (
    <Box
      component="aside"
      sx={{
        display: { xs: "none", md: "flex" },
        position: "fixed",
        inset: "0 auto 0 0",
        width: 244,
        flexDirection: "column",
        borderRight: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
        zIndex: 1100,
      }}
    >
      <Box sx={{ height: 76, display: "flex", alignItems: "center", px: 5 }}>
        <Wordmark />
      </Box>
      <Box sx={{ px: 3, pb: 2 }}>
        <Button
          component={NavLink}
          to="/settings?section=household"
          fullWidth
          variant="outlined"
          color="inherit"
          sx={{
            justifyContent: "flex-start",
            px: 2.5,
            borderColor: "divider",
            bgcolor: "action.hover",
          }}
        >
          <Avatar sx={{ width: 24, height: 24, fontSize: 11, bgcolor: "secondary.main", mr: 2 }}>
            {initial}
          </Avatar>
          <Box sx={{ textAlign: "left", minWidth: 0 }}>
            <Typography
              variant="caption"
              component="span"
              noWrap
              sx={{ display: "block", color: "text.primary", fontWeight: 700, lineHeight: 1.2 }}
            >
              {profile.data?.household.name ?? "Your household"}
            </Typography>
            <Typography
              variant="caption"
              component="span"
              color="text.secondary"
              sx={{ textTransform: "capitalize" }}
            >
              {demo ? "Read-only demo" : (profile.data?.role ?? "member")}
            </Typography>
          </Box>
        </Button>
      </Box>
      <Box
        component="nav"
        aria-label="Primary navigation"
        data-testid="desktop-navigation"
        sx={{ px: 3, py: 1, overflowY: "auto" }}
      >
        <List disablePadding>
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <ListItem key={item.path} disablePadding sx={{ mb: 0.75 }}>
                <ListItemButton
                  component={NavLink}
                  to={item.path}
                  sx={{
                    minHeight: 44,
                    px: 2.5,
                    borderRadius: 2.5,
                    color: "text.secondary",
                    "&.active": {
                      bgcolor: "action.selected",
                      color: "text.primary",
                      "& .MuiListItemIcon-root": { color: "secondary.main" },
                    },
                    "&:hover": { bgcolor: "action.hover", color: "text.primary" },
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 36, color: "inherit" }}>
                    <Badge
                      badgeContent={item.badge}
                      color="error"
                      variant={item.badge ? "standard" : undefined}
                    >
                      <Icon sx={{ fontSize: 20 }} />
                    </Badge>
                  </ListItemIcon>
                  <ListItemText
                    primary={item.label}
                    primaryTypographyProps={{ fontSize: 13, fontWeight: 650 }}
                  />
                </ListItemButton>
              </ListItem>
            );
          })}
        </List>
      </Box>
      <Box sx={{ mt: "auto", p: 4 }}>
        <Box
          sx={{
            p: 3,
            borderRadius: 3,
            bgcolor: "action.hover",
            border: "1px solid",
            borderColor: "divider",
          }}
        >
          <Stack direction="row" alignItems="center" gap={1.5}>
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: 9,
                bgcolor: health.isError
                  ? "warning.main"
                  : health.isPending
                    ? "text.disabled"
                    : "success.main",
                boxShadow:
                  health.isError || health.isPending ? "none" : "0 0 0 4px rgba(31,157,114,0.12)",
              }}
            />
            <Typography variant="caption" sx={{ fontWeight: 750 }}>
              {runtimeLabel}
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
            Sensitive credentials are field-encrypted
          </Typography>
        </Box>
        <Button
          fullWidth
          color="inherit"
          startIcon={<LogoutRounded />}
          disabled={exiting}
          onClick={onExit}
          sx={{ mt: 2, justifyContent: "flex-start" }}
        >
          {exiting ? "Signing out…" : demo ? "Exit demo" : "Sign out"}
        </Button>
      </Box>
    </Box>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const filtered = useMemo(
    () => commands.filter((command) => command.label.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  const go = (path: string) => {
    onClose();
    setQuery("");
    navigate(path);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="command-title"
      PaperProps={{ sx: { alignSelf: "flex-start", mt: { xs: 2, sm: 12 } } }}
    >
      <DialogTitle id="command-title" sx={{ pb: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h3">Find anything</Typography>
          <IconButton aria-label="Close search" onClick={onClose}>
            <CloseRounded />
          </IconButton>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ px: 3, pb: 3 }}>
        <TextField
          fullWidth
          autoFocus
          placeholder="Search pages and actions"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          inputProps={{ "aria-label": "Search BetterWealth" }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchRounded />
              </InputAdornment>
            ),
          }}
        />
        <List sx={{ mt: 2 }}>
          {filtered.map((command) => (
            <ListItem key={command.label} disablePadding>
              <ListItemButton
                onClick={() => go(command.path)}
                sx={{ minHeight: 52, borderRadius: 2 }}
              >
                <ListItemText
                  primary={command.label}
                  secondary={command.group}
                  primaryTypographyProps={{ fontWeight: 650 }}
                />
              </ListItemButton>
            </ListItem>
          ))}
          {!filtered.length ? (
            <Typography color="text.secondary" textAlign="center" sx={{ py: 6 }}>
              No matching page or action.
            </Typography>
          ) : null}
        </List>
      </DialogContent>
    </Dialog>
  );
}

function TopBar() {
  const { privacyEnabled, setPrivacyEnabled } = usePrivacy();
  const { preference, setPreference, resolvedMode } = useAppearance();
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickAnchor, setQuickAnchor] = useState<HTMLElement | null>(null);
  const navigate = useNavigate();
  const demo = isDemoMode();
  const syncRun = useMutation({ mutationFn: api.sync });

  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, []);

  const cycleTheme = () => {
    const next = preference === "system" ? "light" : preference === "light" ? "dark" : "system";
    setPreference(next);
  };

  const sync = () => {
    if (!demo) syncRun.mutate();
  };

  return (
    <>
      <Box
        component="header"
        sx={{
          position: "fixed",
          top: 0,
          left: { xs: 0, md: 244 },
          right: 0,
          height: { xs: 64, sm: 72, md: 76 },
          zIndex: 1050,
          display: "flex",
          alignItems: "center",
          px: { xs: 2, sm: 4, lg: 6 },
          bgcolor: (theme) => alpha(theme.palette.background.default, 0.86),
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Box sx={{ display: { xs: "block", md: "none" }, mr: "auto" }}>
          <Wordmark />
        </Box>
        <Button
          variant="outlined"
          color="inherit"
          startIcon={<SearchRounded />}
          endIcon={<KeyboardCommandKeyRounded sx={{ fontSize: 15 }} />}
          onClick={() => setSearchOpen(true)}
          sx={{
            display: { xs: "none", md: "flex" },
            width: 250,
            justifyContent: "space-between",
            color: "text.secondary",
            borderColor: "divider",
            bgcolor: "background.paper",
          }}
        >
          Search
        </Button>
        <Stack
          direction="row"
          alignItems="center"
          gap={{ xs: 0.5, sm: 1 }}
          sx={{ ml: { xs: 0, md: "auto" } }}
        >
          <Tooltip title="Search BetterWealth">
            <IconButton
              aria-label="Search BetterWealth"
              onClick={() => setSearchOpen(true)}
              sx={{ display: { xs: "inline-flex", md: "none" } }}
            >
              <SearchRounded />
            </IconButton>
          </Tooltip>
          <Tooltip title={privacyEnabled ? "Show monetary values" : "Hide every monetary value"}>
            <IconButton
              aria-label={privacyEnabled ? "Show monetary values" : "Hide monetary values"}
              aria-pressed={privacyEnabled}
              onClick={() => setPrivacyEnabled(!privacyEnabled)}
            >
              {privacyEnabled ? <VisibilityOffRounded /> : <VisibilityRounded />}
            </IconButton>
          </Tooltip>
          <Tooltip title={`Theme: ${preference}`}>
            <IconButton aria-label={`Theme is ${preference}; change theme`} onClick={cycleTheme}>
              {resolvedMode === "dark" ? <DarkModeRounded /> : <LightModeRounded />}
            </IconButton>
          </Tooltip>
          <Tooltip
            describeChild
            title={syncRun.isError ? "Sync failed; try again" : "Sync accounts now"}
          >
            <span>
              <IconButton
                aria-label={syncRun.isError ? "Sync failed; try again" : "Sync accounts now"}
                color={syncRun.isError ? "error" : "default"}
                disabled={syncRun.isPending}
                onClick={sync}
                sx={{ display: { xs: "inline-flex", sm: "none" } }}
              >
                <SyncRounded
                  sx={{
                    animation: syncRun.isPending ? "spin .8s linear infinite" : "none",
                    "@keyframes spin": { to: { transform: "rotate(360deg)" } },
                  }}
                />
              </IconButton>
            </span>
          </Tooltip>
          <Button
            variant="text"
            color={syncRun.isError ? "error" : "inherit"}
            aria-label={syncRun.isError ? "Sync failed; try again" : "Sync accounts now"}
            startIcon={
              <SyncRounded
                sx={{
                  animation: syncRun.isPending ? "spin .8s linear infinite" : "none",
                  "@keyframes spin": { to: { transform: "rotate(360deg)" } },
                }}
              />
            }
            onClick={sync}
            disabled={syncRun.isPending}
            sx={{
              display: { xs: "none", sm: "flex" },
              color: syncRun.isError ? "error.main" : "text.secondary",
            }}
          >
            {syncRun.isPending
              ? "Syncing"
              : syncRun.isError
                ? "Sync failed"
                : syncRun.data?.state === "queued" || syncRun.data?.state === "leased"
                  ? "Sync queued"
                  : "Sync now"}
          </Button>
          <Button
            variant="contained"
            aria-label="Quick add"
            startIcon={<AddRounded />}
            onClick={(event) => setQuickAnchor(event.currentTarget)}
            sx={{
              minWidth: { xs: 44, sm: "auto" },
              px: { xs: 0, sm: 4 },
              "& .MuiButton-startIcon": { mr: { xs: 0, sm: 1 } },
            }}
          >
            <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>
              Quick add
            </Box>
          </Button>
        </Stack>
      </Box>
      <Menu
        anchorEl={quickAnchor}
        open={Boolean(quickAnchor)}
        onClose={() => setQuickAnchor(null)}
        MenuListProps={{ "aria-label": "Quick add" }}
      >
        {quickActions.map((action) => {
          const Icon = action.icon;
          return (
            <MenuItem
              key={action.label}
              onClick={() => {
                setQuickAnchor(null);
                navigate(action.path);
              }}
              sx={{ minHeight: 44, minWidth: 210 }}
            >
              <ListItemIcon>
                <Icon fontSize="small" />
              </ListItemIcon>
              {action.label}
            </MenuItem>
          );
        })}
      </Menu>
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}

function MobileBottomBar({ onExit, exiting }: { onExit: () => void; exiting: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const [moreOpen, setMoreOpen] = useState(false);
  const demo = isDemoMode();
  const current =
    mobilePrimary.find((item) => location.pathname.startsWith(item.path))?.path ??
    (mobileMore.some((item) => location.pathname.startsWith(item.path)) ? "more" : "/today");

  if (!isMobile) return null;

  return (
    <>
      <Box
        component="nav"
        aria-label="Mobile navigation"
        data-testid="mobile-navigation"
        sx={{
          position: "fixed",
          zIndex: 1200,
          inset: "auto 0 0 0",
          bgcolor: "background.paper",
          borderTop: "1px solid",
          borderColor: "divider",
          pb: "env(safe-area-inset-bottom)",
        }}
      >
        <BottomNavigation
          value={current}
          showLabels
          onChange={(_, value: string) => (value === "more" ? setMoreOpen(true) : navigate(value))}
          sx={{
            height: 68,
            bgcolor: "transparent",
            "& .MuiBottomNavigationAction-root": {
              minWidth: 0,
              minHeight: 56,
              py: 1,
              color: "text.secondary",
            },
            "& .Mui-selected": { color: "secondary.main" },
            "& .MuiBottomNavigationAction-label": { fontSize: "0.66rem", fontWeight: 700, mt: 0.5 },
          }}
        >
          {mobilePrimary.map((item) => {
            const Icon = item.icon;
            return (
              <BottomNavigationAction
                key={item.path}
                label={item.label}
                value={item.path}
                icon={
                  <Badge variant={item.badge ? "dot" : undefined} color="error">
                    <Icon sx={{ fontSize: 22 }} />
                  </Badge>
                }
              />
            );
          })}
          <BottomNavigationAction
            label="More"
            value="more"
            icon={<MoreHorizRounded sx={{ fontSize: 23 }} />}
          />
        </BottomNavigation>
      </Box>
      <Drawer
        anchor="bottom"
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        PaperProps={{ sx: { borderRadius: "18px 18px 0 0", pb: "env(safe-area-inset-bottom)" } }}
      >
        <Box sx={{ p: 4 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Box>
              <Typography variant="h3">More</Typography>
              <Typography variant="body2" color="text.secondary">
                Your full BetterWealth workspace
              </Typography>
            </Box>
            <IconButton onClick={() => setMoreOpen(false)} aria-label="Close more menu">
              <CloseRounded />
            </IconButton>
          </Stack>
          <List sx={{ mt: 2 }}>
            {mobileMore.map((item) => {
              const Icon = item.icon;
              return (
                <ListItem key={item.path} disablePadding>
                  <ListItemButton
                    onClick={() => {
                      setMoreOpen(false);
                      navigate(item.path);
                    }}
                    sx={{ minHeight: 56, borderRadius: 2.5 }}
                  >
                    <ListItemIcon>
                      <Badge badgeContent={item.badge} color="error">
                        <Icon />
                      </Badge>
                    </ListItemIcon>
                    <ListItemText
                      primary={item.label}
                      primaryTypographyProps={{ fontWeight: 650 }}
                    />
                  </ListItemButton>
                </ListItem>
              );
            })}
          </List>
          <Divider sx={{ my: 2 }} />
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ minHeight: 52 }}
          >
            <Stack direction="row" alignItems="center" gap={2}>
              <LockOutlineRounded color="success" />
              <Box>
                <Typography variant="body2" fontWeight={700}>
                  Private by design
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  No analytics or ad tracking
                </Typography>
              </Box>
            </Stack>
            <Chip label="Local" size="small" />
          </Stack>
          <Button
            fullWidth
            color="inherit"
            startIcon={<LogoutRounded />}
            disabled={exiting}
            onClick={onExit}
            sx={{ mt: 2 }}
          >
            {exiting ? "Signing out…" : demo ? "Exit demo" : "Sign out"}
          </Button>
        </Box>
      </Drawer>
    </>
  );
}

export function AppShell() {
  const demo = isDemoMode();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const exitSession = useMutation({
    mutationFn: async () => {
      if (!demo) await api.logout();
    },
    onSuccess: () => {
      window.sessionStorage.removeItem("bw-demo");
      queryClient.clear();
      navigate("/login", { replace: true });
    },
  });
  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <DesktopRail onExit={() => exitSession.mutate()} exiting={exitSession.isPending} />
      <TopBar />
      <Box
        component="main"
        id="main-content"
        sx={{
          ml: { xs: 0, md: "244px" },
          pt: { xs: "64px", sm: "72px", md: "76px" },
          pb: { xs: "88px", md: 8 },
          minWidth: 0,
        }}
      >
        <Box
          sx={{
            width: "100%",
            maxWidth: 1480,
            mx: "auto",
            px: { xs: 3, sm: 5, lg: 7 },
            py: { xs: 5, sm: 7 },
          }}
        >
          <Outlet />
        </Box>
      </Box>
      <MobileBottomBar onExit={() => exitSession.mutate()} exiting={exitSession.isPending} />
      <Snackbar
        open={exitSession.isError}
        autoHideDuration={6_000}
        onClose={() => exitSession.reset()}
      >
        <Alert severity="error" onClose={() => exitSession.reset()}>
          Sign out failed. Your session is still active; try again.
        </Alert>
      </Snackbar>
    </Box>
  );
}
