import {
  AccountBalanceRounded,
  AddRounded,
  BackupRounded,
  CheckCircleRounded,
  CloudDownloadRounded,
  CloudSyncRounded,
  CodeRounded,
  CurrencyExchangeRounded,
  DataObjectRounded,
  DevicesRounded,
  DownloadRounded,
  GroupRounded,
  HistoryRounded,
  KeyRounded,
  LanguageRounded,
  PaletteRounded,
  PersonRounded,
  RefreshRounded,
  SecurityRounded,
  SmartToyRounded,
  StorageRounded,
} from "@mui/icons-material";
import {
  Alert,
  Avatar,
  alpha,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { type AiIntegrationConfig, api, type IntegrationSettings } from "../api";
import { ListItemText, Stack, Switch, TextField, Typography } from "../components/mui";
import { ErrorState, LoadingCard, PageHeader, SectionHeader, StatusChip } from "../components/ui";
import { type ThemePreference, useAppearance, usePrivacy } from "../contexts";
import { isDemoMode } from "../demo";

const settingsNavigation = [
  { id: "profile", label: "Profile & target", icon: PersonRounded },
  { id: "household", label: "Household", icon: GroupRounded },
  { id: "currencies", label: "Currencies", icon: CurrencyExchangeRounded },
  { id: "integrations", label: "Integrations", icon: CloudSyncRounded },
  { id: "security", label: "Security", icon: SecurityRounded },
  { id: "appearance", label: "Appearance", icon: PaletteRounded },
  { id: "data", label: "Data & backups", icon: StorageRounded },
  { id: "audit", label: "Audit log", icon: HistoryRounded },
  { id: "health", label: "Diagnostics", icon: DataObjectRounded },
];

function SettingsCard({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent sx={{ p: { xs: 4, sm: 5 } }}>
        <SectionHeader
          title={title}
          {...(description ? { description } : {})}
          {...(action ? { action } : {})}
        />
        <Divider sx={{ my: 4 }} />
        {children}
      </CardContent>
    </Card>
  );
}

function ProfileSettings() {
  const demo = isDemoMode();
  const queryClient = useQueryClient();
  const demoProfile = {
    user: {
      id: "demo_user",
      email: "alex@example.com",
      displayName: "Alex Morgan",
      birthDate: "2004-04-18",
      targetAge: 30,
      emailVerifiedAt: null,
    },
    household: {
      id: "demo_household",
      name: "Alex's household",
      baseCurrency: "USD",
      locale: "en-US",
      timezone: "America/New_York",
    },
    role: "owner" as const,
  };
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: api.profile,
    initialData: demo ? demoProfile : undefined,
    enabled: !demo,
    retry: 1,
  });
  const [displayName, setDisplayName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [targetAge, setTargetAge] = useState("30");
  const [householdName, setHouseholdName] = useState("");
  const [baseCurrency, setBaseCurrency] = useState("USD");
  const [timezone, setTimezone] = useState("America/New_York");
  useEffect(() => {
    if (!profile.data) return;
    setDisplayName(profile.data.user.displayName ?? "");
    setBirthDate(profile.data.user.birthDate ?? "");
    setTargetAge(profile.data.user.targetAge?.toString() ?? "30");
    setHouseholdName(profile.data.household.name);
    setBaseCurrency(profile.data.household.baseCurrency);
    setTimezone(profile.data.household.timezone);
  }, [profile.data]);
  const save = useMutation({
    mutationFn: () =>
      api.updateProfile({
        displayName: displayName.trim(),
        birthDate: birthDate || null,
        targetAge: targetAge ? Number(targetAge) : null,
        ...(profile.data?.role === "owner" || profile.data?.role === "admin"
          ? {
              householdName: householdName.trim(),
              baseCurrency,
              timezone: timezone.trim(),
            }
          : {}),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["profile"] }),
        queryClient.invalidateQueries({ queryKey: ["session"] }),
      ]);
    },
  });
  if (profile.isPending) return <LoadingCard rows={6} />;
  if (profile.isError || !profile.data) {
    return (
      <ErrorState message="Your profile could not be loaded." onRetry={() => profile.refetch()} />
    );
  }
  const canManageHousehold = profile.data.role === "owner" || profile.data.role === "admin";
  const initial = (displayName || profile.data.user.email).trim().charAt(0).toUpperCase();
  return (
    <Stack gap={4}>
      <SettingsCard
        title="Your profile"
        description="Live account details used by your household plan and forecasts."
      >
        <Stack
          direction={{ xs: "column", sm: "row" }}
          gap={4}
          alignItems={{ xs: "flex-start", sm: "center" }}
        >
          <Avatar sx={{ width: 64, height: 64, bgcolor: "secondary.main", fontSize: 22 }}>
            {initial}
          </Avatar>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" },
              gap: 3,
              flex: 1,
              width: "100%",
            }}
          >
            <TextField
              label="Name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <TextField
              label="Email"
              value={profile.data.user.email}
              type="email"
              disabled
              helperText="Email changes are not available yet."
            />
            <TextField
              label="Birth date"
              value={birthDate}
              onChange={(event) => setBirthDate(event.target.value)}
              type="date"
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Target age"
              value={targetAge}
              onChange={(event) => setTargetAge(event.target.value)}
              type="number"
              inputProps={{ min: 18, max: 120 }}
            />
          </Box>
        </Stack>
      </SettingsCard>
      <SettingsCard
        title="Household plan"
        description="Reporting defaults shared by every household member."
      >
        <Box
          sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)" }, gap: 3 }}
        >
          <TextField
            label="Household name"
            value={householdName}
            disabled={!canManageHousehold}
            onChange={(event) => setHouseholdName(event.target.value)}
          />
          <FormControl size="small" disabled={!canManageHousehold}>
            <InputLabel id="profile-base-currency">Base currency</InputLabel>
            <Select
              labelId="profile-base-currency"
              label="Base currency"
              value={baseCurrency}
              onChange={(event) => setBaseCurrency(event.target.value)}
            >
              {["USD", "CAD", "EUR", "GBP"].map((currency) => (
                <MenuItem key={currency} value={currency}>
                  {currency}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            label="Timezone"
            value={timezone}
            disabled={!canManageHousehold}
            onChange={(event) => setTimezone(event.target.value)}
            helperText="Use an IANA timezone, such as America/New_York."
          />
          <TextField label="Household role" value={profile.data.role} disabled />
        </Box>
        <Alert severity="info" sx={{ mt: 4 }}>
          Your birth date and target age drive the age-30 forecast horizon. Financial targets are
          managed as goals, so every dollar remains traceable.
        </Alert>
        {save.error instanceof Error ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {save.error.message}
          </Alert>
        ) : null}
        {save.isSuccess ? (
          <Alert severity="success" sx={{ mt: 3 }}>
            Profile saved.
          </Alert>
        ) : null}
        <Button
          variant="contained"
          sx={{ mt: 4 }}
          disabled={save.isPending || !displayName.trim() || !householdName.trim()}
          onClick={() => (demo ? undefined : save.mutate())}
        >
          {save.isPending ? "Saving…" : "Save profile"}
        </Button>
      </SettingsCard>
    </Stack>
  );
}

function HouseholdSettings() {
  const demo = isDemoMode();
  const members = useQuery({
    queryKey: ["household-members"],
    queryFn: api.householdMembers,
    initialData: demo
      ? {
          data: [
            {
              id: "demo_user",
              email: "alex@example.com",
              displayName: "Alex Morgan",
              role: "owner" as const,
              status: "active" as const,
              joinedAt: new Date().toISOString(),
            },
          ],
          page: { cursor: null, hasMore: false },
        }
      : undefined,
    enabled: !demo,
    retry: 1,
  });
  if (members.isPending) return <LoadingCard rows={5} />;
  if (members.isError)
    return (
      <ErrorState
        message="Household members could not be loaded."
        onRetry={() => members.refetch()}
      />
    );
  return (
    <Stack gap={4}>
      <SettingsCard
        title="Household members"
        description="Live, read-only membership. Roles are enforced by the API on every household-scoped row."
      >
        <Stack divider={<Divider />}>
          {members.data?.data.map((member) => {
            const label = member.displayName || member.email;
            return (
              <Stack key={member.id} direction="row" alignItems="center" gap={3} sx={{ py: 3 }}>
                <Avatar
                  sx={{ width: 40, height: 40, bgcolor: "action.selected", color: "text.primary" }}
                >
                  {label.charAt(0).toUpperCase()}
                </Avatar>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={700}>
                    {label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {member.email} · joined {new Date(member.joinedAt).toLocaleDateString()}
                  </Typography>
                </Box>
                <StatusChip
                  label={member.status}
                  tone={member.status === "active" ? "positive" : "warning"}
                />
                <Chip label={member.role} size="small" variant="outlined" />
              </Stack>
            );
          })}
        </Stack>
      </SettingsCard>
      <SettingsCard
        title="Membership administration"
        description="Invitations, role edits, and registration-policy controls are not enabled in this build."
      >
        <Alert severity="info">
          The current API exposes household membership read-only. No invitation or role control is
          shown until it can be enforced end to end.
        </Alert>
        <Button disabled startIcon={<AddRounded />} sx={{ mt: 3 }}>
          Invite member
        </Button>
      </SettingsCard>
    </Stack>
  );
}

function CurrencySettings() {
  const demo = isDemoMode();
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: api.profile,
    initialData: demo
      ? {
          user: {
            id: "demo_user",
            email: "alex@example.com",
            displayName: "Alex Morgan",
            birthDate: null,
            targetAge: 30,
            emailVerifiedAt: null,
          },
          household: {
            id: "demo_household",
            name: "Alex's household",
            baseCurrency: "USD",
            locale: "en-US",
            timezone: "America/New_York",
          },
          role: "owner" as const,
        }
      : undefined,
    enabled: !demo,
    retry: 1,
  });
  if (profile.isPending) return <LoadingCard rows={3} />;
  if (profile.isError || !profile.data)
    return (
      <ErrorState
        message="Currency settings could not be loaded."
        onRetry={() => profile.refetch()}
      />
    );
  return (
    <Stack gap={4}>
      <SettingsCard
        title="Reporting currency"
        description="Reports use the household base currency; imported accounts retain their native currency."
      >
        <TextField
          label="Base / reporting currency"
          value={profile.data.household.baseCurrency}
          disabled
          fullWidth
        />
        <Alert severity="info" sx={{ mt: 3 }}>
          Change the base currency in Profile & target. Automated exchange-rate conversion is not
          enabled yet, so cross-currency totals remain explicitly limited.
        </Alert>
      </SettingsCard>
      <SettingsCard
        title="Exchange-rate provider"
        description="Provider configuration is planned but not exposed until converted reports are implemented end to end."
      >
        <Button disabled startIcon={<AddRounded />}>
          Configure provider
        </Button>
      </SettingsCard>
    </Stack>
  );
}

function IntegrationCard({
  icon,
  title,
  description,
  status,
  action,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  status: string;
  action: string;
  onAction?: () => void;
}) {
  return (
    <Box sx={{ p: 4, border: "1px solid", borderColor: "divider", borderRadius: 3 }}>
      <Stack direction="row" gap={3} alignItems="flex-start">
        <Box
          sx={{
            width: 42,
            height: 42,
            flex: "0 0 auto",
            borderRadius: 2.5,
            display: "grid",
            placeItems: "center",
            bgcolor: "action.hover",
            color: "text.secondary",
          }}
        >
          {icon}
        </Box>
        <Box sx={{ flex: 1 }}>
          <Stack direction="row" justifyContent="space-between" gap={2}>
            <Typography variant="h3">{title}</Typography>
            <StatusChip
              label={status}
              tone={
                status === "Connected" ? "positive" : status === "Optional" ? "info" : "neutral"
              }
            />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {description}
          </Typography>
          <Button variant="outlined" sx={{ mt: 3 }} onClick={onAction} disabled={!onAction}>
            {action}
          </Button>
        </Box>
      </Stack>
    </Box>
  );
}

function IntegrationsSettings() {
  const demo = isDemoMode();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const demoSettings: IntegrationSettings = {
    ai: { enabled: false, provider: null, model: null, consentedFields: [] },
    exchangeRates: { provider: "manual", enabled: false },
    valuations: { providers: ["manual"] },
  };
  const demoAiConfig: AiIntegrationConfig = {
    configured: false,
    enabled: false,
    baseUrl: "https://openrouter.ai/api/v1",
    model: "tencent/hy3:free",
    confidenceThreshold: 0.9,
  };
  const settings = useQuery({
    queryKey: ["integration-settings"],
    queryFn: api.integrationSettings,
    initialData: demo ? demoSettings : undefined,
    enabled: !demo,
    retry: 1,
  });
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: api.connections,
    initialData: demo ? { data: [], page: { cursor: null, hasMore: false } } : undefined,
    enabled: !demo,
    retry: 1,
  });
  const aiConfig = useQuery({
    queryKey: ["ai-integration-config"],
    queryFn: api.aiIntegrationConfig,
    initialData: demo ? demoAiConfig : undefined,
    enabled: !demo,
    retry: 1,
  });
  const [aiConsent, setAiConsent] = useState(false);
  const [aiConfigOpen, setAiConfigOpen] = useState(false);
  const [aiBaseUrl, setAiBaseUrl] = useState(demoAiConfig.baseUrl);
  const [aiModel, setAiModel] = useState(demoAiConfig.model ?? "");
  const [aiKey, setAiKey] = useState("");
  const [aiThreshold, setAiThreshold] = useState("90");
  const [simpleFinOpen, setSimpleFinOpen] = useState(false);
  const [setupToken, setSetupToken] = useState("");
  const closeAiConfig = () => {
    setAiConfigOpen(false);
    setAiKey("");
    setAiConsent(Boolean(settings.data?.ai.enabled));
  };
  useEffect(() => setAiConsent(Boolean(settings.data?.ai.enabled)), [settings.data?.ai.enabled]);
  useEffect(() => {
    if (!aiConfig.data) return;
    setAiBaseUrl(aiConfig.data.baseUrl);
    setAiModel(aiConfig.data.model ?? "");
    setAiThreshold(String(Math.round(aiConfig.data.confidenceThreshold * 100)));
  }, [aiConfig.data]);
  const saveAi = useMutation({
    mutationFn: (enabled: boolean) =>
      api.updateIntegrationSettings({
        ai: {
          enabled,
          provider: settings.data?.ai.provider ?? "openrouter",
          model: settings.data?.ai.model ?? null,
          consentedFields: enabled
            ? [
                "normalized_description",
                "direction",
                "coarse_amount",
                "account_type",
                "allowed_categories",
                "limited_examples",
              ]
            : [],
        },
      }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["integration-settings"] }),
  });
  const claim = useMutation({
    mutationFn: () => api.claimSimpleFin({ setupToken }),
    onSuccess: async () => {
      setSimpleFinOpen(false);
      setSetupToken("");
      await queryClient.invalidateQueries({ queryKey: ["connections"] });
    },
  });
  const saveAiConfig = useMutation({
    mutationFn: () =>
      api.updateAiIntegrationConfig({
        enabled: aiConsent,
        consent: true,
        baseUrl: aiBaseUrl.trim(),
        model: aiModel.trim(),
        ...(aiKey.trim() ? { apiKey: aiKey.trim() } : {}),
        confidenceThreshold: Number(aiThreshold) / 100,
      }),
    onSuccess: async () => {
      setAiConfigOpen(false);
      setAiKey("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["integration-settings"] }),
        queryClient.invalidateQueries({ queryKey: ["ai-integration-config"] }),
      ]);
    },
  });
  const simpleFin = connections.data?.data.find((item) => item.provider === "simplefin");
  const validAiThreshold =
    Number.isFinite(Number(aiThreshold)) && Number(aiThreshold) >= 0 && Number(aiThreshold) <= 100;
  let validAiUrl = false;
  try {
    const parsed = new URL(aiBaseUrl);
    validAiUrl = parsed.protocol === "https:";
  } catch {
    validAiUrl = false;
  }
  const canSaveAiConfig =
    validAiUrl &&
    Boolean(aiModel.trim()) &&
    validAiThreshold &&
    (Boolean(aiConfig.data?.configured) || aiKey.trim().length >= 10);
  if (settings.isPending || connections.isPending || aiConfig.isPending)
    return <LoadingCard rows={6} />;
  if (settings.isError || connections.isError || aiConfig.isError)
    return (
      <ErrorState
        message="Integration settings could not be loaded."
        onRetry={() => {
          void settings.refetch();
          void connections.refetch();
          void aiConfig.refetch();
        }}
      />
    );
  return (
    <Stack gap={4}>
      <SettingsCard
        title="Financial data"
        description="Connection status is separate from account health."
      >
        <Stack gap={3}>
          <IntegrationCard
            icon={<CloudSyncRounded />}
            title="SimpleFIN"
            description={
              simpleFin
                ? `${simpleFin.displayName} · last sync ${simpleFin.lastSuccessfulAt ? new Date(simpleFin.lastSuccessfulAt).toLocaleString() : "not yet"}`
                : "Claim a one-time setup token; the resulting access URL stays server-side and encrypted."
            }
            status={simpleFin ? "Connected" : "Available"}
            action={simpleFin ? "View synced accounts" : "Connect SimpleFIN"}
            onAction={() => (simpleFin ? navigate("/accounts") : setSimpleFinOpen(true))}
          />
          <IntegrationCard
            icon={<CloudDownloadRounded />}
            title="File import"
            description="Preview and import CSV, QFX, or OFX files into a selected account. Duplicate provider IDs and normalized transaction fingerprints are reconciled server-side."
            status="Available"
            action="Import transactions"
            onAction={() => navigate("/transactions?action=import")}
          />
        </Stack>
      </SettingsCard>
      <SettingsCard
        title="Optional providers"
        description="Configure supported providers here; unavailable adapters remain visibly disabled."
      >
        <Stack gap={3}>
          <IntegrationCard
            icon={<SmartToyRounded />}
            title="OpenRouter-compatible AI"
            description={`${aiConfig.data?.model ?? "No model selected"} · the API key is encrypted per user and is never returned to this browser.`}
            status={
              settings.data?.ai.enabled
                ? "Connected"
                : aiConfig.data?.configured
                  ? "Configured"
                  : "Optional"
            }
            action={aiConfig.data?.configured ? "Edit configuration" : "Configure"}
            onAction={() => setAiConfigOpen(true)}
          />
          <IntegrationCard
            icon={<LanguageRounded />}
            title="Exchange rates"
            description="Native values are preserved. Automatic converted reporting is not enabled yet."
            status="Planned"
            action="Coming soon"
          />
          <IntegrationCard
            icon={<AccountBalanceRounded />}
            title="Asset valuations"
            description="Manual valuations work today; property and vehicle provider adapters are planned."
            status="Manual"
            action="Use Net worth"
            onAction={() => navigate("/net-worth")}
          />
        </Stack>
      </SettingsCard>
      <SettingsCard
        title="AI consent & field disclosure"
        description="Consent is off until explicitly enabled for this household."
      >
        <FormControlLabel
          control={
            <Switch
              checked={aiConsent}
              disabled={saveAi.isPending}
              onChange={(event) => {
                const enabled = event.target.checked;
                setAiConsent(enabled);
                if (enabled && !aiConfig.data?.configured) {
                  setAiConfigOpen(true);
                  return;
                }
                if (!demo) saveAi.mutate(enabled);
              }}
            />
          }
          label={
            <Box>
              <Typography variant="body2" fontWeight={700}>
                Allow bounded AI categorization requests
              </Typography>
              <Typography variant="caption" color="text.secondary">
                High-confidence narrow patterns may create deterministic rules automatically;
                uncertain suggestions wait for review.
              </Typography>
            </Box>
          }
        />
        {saveAi.error instanceof Error ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {saveAi.error.message}
          </Alert>
        ) : null}
        <Box sx={{ mt: 4, p: 4, borderRadius: 3, bgcolor: "action.hover" }}>
          <Typography variant="overline" color="text.secondary">
            Fields eligible to be sent
          </Typography>
          <Stack direction="row" flexWrap="wrap" gap={1.5} sx={{ mt: 2 }}>
            {[
              "Normalized description",
              "Inflow / outflow",
              "Coarse amount range",
              "Account type",
              "Allowed categories",
              "Limited examples",
            ].map((field) => (
              <Chip key={field} label={field} size="small" />
            ))}
          </Stack>
          <Typography variant="overline" color="text.secondary" sx={{ display: "block", mt: 4 }}>
            Never sent
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            Credentials, setup/access URLs, full account numbers, email, unrelated transactions, and
            notes by default.
          </Typography>
        </Box>
      </SettingsCard>
      <Dialog open={aiConfigOpen} onClose={closeAiConfig} fullWidth maxWidth="sm">
        <DialogTitle>Configure AI categorization</DialogTitle>
        <DialogContent>
          <Stack gap={3} sx={{ mt: 1 }}>
            <Alert severity="info">
              The key is sent only to your BetterWealth API, encrypted at rest, and never returned.
              Provider requests use the consented transaction fields listed on this page.
            </Alert>
            <TextField
              label="OpenAI-compatible base URL"
              type="url"
              value={aiBaseUrl}
              onChange={(event) => setAiBaseUrl(event.target.value)}
              error={Boolean(aiBaseUrl) && !validAiUrl}
              helperText={
                validAiUrl ? "HTTPS is required for provider egress." : "Enter a valid HTTPS URL."
              }
              fullWidth
            />
            <TextField
              label="Model"
              value={aiModel}
              onChange={(event) => setAiModel(event.target.value)}
              placeholder="tencent/hy3:free"
              fullWidth
            />
            <TextField
              label={aiConfig.data?.configured ? "Replace API key (optional)" : "API key"}
              type="password"
              autoComplete="off"
              value={aiKey}
              onChange={(event) => setAiKey(event.target.value)}
              helperText={
                aiConfig.data?.configured
                  ? "Leave blank to keep the encrypted key already configured."
                  : "Required the first time this user configures a provider."
              }
              fullWidth
            />
            <TextField
              label="Automatic-rule confidence threshold"
              type="number"
              value={aiThreshold}
              onChange={(event) => setAiThreshold(event.target.value)}
              error={Boolean(aiThreshold) && !validAiThreshold}
              helperText="0–100%. Lower-confidence suggestions stay in review."
              InputProps={{ endAdornment: <Typography color="text.secondary">%</Typography> }}
              inputProps={{ min: 0, max: 100, step: 1 }}
              fullWidth
            />
          </Stack>
        </DialogContent>
        {saveAiConfig.error instanceof Error ? (
          <Alert severity="error" sx={{ mx: 3 }}>
            {saveAiConfig.error.message}
          </Alert>
        ) : null}
        <DialogActions>
          <Button onClick={closeAiConfig}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!canSaveAiConfig || saveAiConfig.isPending}
            onClick={() => (demo ? setAiConfigOpen(false) : saveAiConfig.mutate())}
          >
            {saveAiConfig.isPending ? "Saving…" : "Save encrypted configuration"}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={simpleFinOpen} onClose={() => setSimpleFinOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>{simpleFin ? "SimpleFIN connection" : "Connect SimpleFIN"}</DialogTitle>
        <DialogContent>
          {simpleFin ? (
            <Alert severity="success">
              Connected. Sync runs use the durable idempotent job queue.
            </Alert>
          ) : (
            <Stack gap={3} sx={{ mt: 1 }}>
              <Alert severity="info">
                The token is claimed once by the API, and the access URL is never returned to this
                browser.
              </Alert>
              <TextField
                label="One-time setup token"
                value={setupToken}
                onChange={(event) => setSetupToken(event.target.value)}
                multiline
                minRows={3}
              />
            </Stack>
          )}
        </DialogContent>
        {claim.error instanceof Error ? (
          <Alert severity="error" sx={{ mx: 3 }}>
            {claim.error.message}
          </Alert>
        ) : null}
        <DialogActions>
          <Button onClick={() => setSimpleFinOpen(false)}>Close</Button>
          {!simpleFin ? (
            <Button
              variant="contained"
              disabled={!setupToken.trim() || claim.isPending}
              onClick={() => (demo ? setSimpleFinOpen(false) : claim.mutate())}
            >
              {claim.isPending ? "Claiming…" : "Claim & queue sync"}
            </Button>
          ) : null}
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function SecuritySettings() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const demo = isDemoMode();
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: api.sessions,
    initialData: demo
      ? {
          data: [
            {
              id: "demo_session",
              current: true,
              userAgent: "Demo browser",
              ipAddress: "local",
              lastSeenAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
          ],
          page: { cursor: null, hasMore: false },
        }
      : undefined,
    enabled: !demo,
    retry: 1,
  });
  const password = useMutation({
    mutationFn: () => api.changePassword({ currentPassword, newPassword }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeSession(id),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
  });
  if (sessionQuery.isPending) return <LoadingCard rows={5} />;
  if (sessionQuery.isError)
    return (
      <ErrorState
        message="Security sessions could not be loaded."
        onRetry={() => sessionQuery.refetch()}
      />
    );
  const sessions = sessionQuery.data?.data ?? [];
  return (
    <Stack gap={4}>
      <SettingsCard
        title="Password"
        description="Changing your password revokes every other active session."
      >
        <Stack direction={{ xs: "column", sm: "row" }} gap={3}>
          <TextField
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            fullWidth
          />
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            helperText="At least 12 characters"
            fullWidth
          />
        </Stack>
        {password.error instanceof Error ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {password.error.message}
          </Alert>
        ) : null}
        {password.isSuccess ? (
          <Alert severity="success" sx={{ mt: 3 }}>
            Password changed. Other sessions were revoked.
          </Alert>
        ) : null}
        <Button
          variant="contained"
          disabled={currentPassword.length < 1 || newPassword.length < 12 || password.isPending}
          onClick={() => (demo ? undefined : password.mutate())}
          sx={{ mt: 4 }}
        >
          {password.isPending ? "Changing…" : "Change password"}
        </Button>
      </SettingsCard>
      <SettingsCard
        title="Active sessions"
        description="Live session inventory from the authentication API."
      >
        <Stack divider={<Divider />}>
          {sessions.map((session) => (
            <Stack key={session.id} direction="row" alignItems="center" gap={3} sx={{ py: 3 }}>
              <DevicesRounded color="action" />
              <Box sx={{ flex: 1 }}>
                <Typography variant="body2" fontWeight={700}>
                  {session.userAgent}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {session.ipAddress} · seen {new Date(session.lastSeenAt).toLocaleString()} ·
                  expires {new Date(session.expiresAt).toLocaleDateString()}
                </Typography>
              </Box>
              {session.current ? (
                <StatusChip label="Current" tone="positive" />
              ) : (
                <Button
                  color="error"
                  disabled={revoke.isPending}
                  onClick={() => (demo ? undefined : revoke.mutate(session.id))}
                >
                  Revoke
                </Button>
              )}
            </Stack>
          ))}
        </Stack>
        {revoke.error instanceof Error ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {revoke.error.message}
          </Alert>
        ) : null}
        <Button
          color="error"
          variant="outlined"
          disabled={revoke.isPending || !sessions.some((session) => !session.current)}
          onClick={() => {
            if (!demo)
              sessions
                .filter((session) => !session.current)
                .forEach((session) => {
                  revoke.mutate(session.id);
                });
          }}
          sx={{ mt: 4 }}
        >
          Revoke all other sessions
        </Button>
      </SettingsCard>
      <SettingsCard
        title="Personal access tokens"
        description="Programmatic tokens are not available in this build."
      >
        <Alert severity="info">
          No token controls are exposed until scoped authorization, one-time display, rotation, and
          audit coverage are complete.
        </Alert>
        <Button disabled startIcon={<AddRounded />} sx={{ mt: 3 }}>
          Create token
        </Button>
      </SettingsCard>
      <SettingsCard
        title="Future sign-in methods"
        description="Passkeys and external OAuth are planned, but not enabled in this build."
      >
        <Stack direction="row" gap={2}>
          <Button disabled startIcon={<KeyRounded />}>
            Add passkey
          </Button>
          <Button disabled>Connect OAuth</Button>
        </Stack>
      </SettingsCard>
    </Stack>
  );
}

function AppearanceSettings() {
  const { preference, setPreference } = useAppearance();
  const { privacyEnabled, setPrivacyEnabled } = usePrivacy();
  return (
    <Stack gap={4}>
      <SettingsCard title="Theme" description="Warm light, deep dark, or your system preference.">
        <RadioGroup
          row
          value={preference}
          onChange={(event) => setPreference(event.target.value as ThemePreference)}
        >
          {(["light", "dark", "system"] as const).map((mode) => (
            <FormControlLabel
              key={mode}
              value={mode}
              control={<Radio />}
              label={mode[0]?.toUpperCase() + mode.slice(1)}
            />
          ))}
        </RadioGroup>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "repeat(3, 1fr)" },
            gap: 3,
            mt: 4,
          }}
        >
          {[
            ["Light", "#F7F7F5", "#FFFFFF", "#151A22"],
            ["Dark", "#0B1017", "#111923", "#F3F6F8"],
            ["System", "#F7F7F5", "#111923", "#1F9D72"],
          ].map(([label, bg, surface, accent]) => (
            <Box
              key={label}
              sx={{
                p: 2,
                border: "1px solid",
                borderColor: preference === label?.toLowerCase() ? "secondary.main" : "divider",
                borderRadius: 3,
                bgcolor: bg,
              }}
            >
              <Box
                sx={{
                  height: 68,
                  borderRadius: 2,
                  bgcolor: surface,
                  border: "1px solid rgba(127,127,127,.18)",
                  p: 2,
                }}
              >
                <Box sx={{ width: "45%", height: 7, borderRadius: 4, bgcolor: accent }} />
                <Box
                  sx={{
                    width: "72%",
                    height: 5,
                    borderRadius: 4,
                    bgcolor: alpha(accent ?? "#000", 0.28),
                    mt: 2,
                  }}
                />
              </Box>
              <Typography variant="caption" sx={{ display: "block", mt: 2, color: accent }}>
                {label}
              </Typography>
            </Box>
          ))}
        </Box>
      </SettingsCard>
      <SettingsCard title="Privacy & motion">
        <Stack gap={4}>
          <FormControlLabel
            control={
              <Switch
                checked={privacyEnabled}
                onChange={(event) => setPrivacyEnabled(event.target.checked)}
              />
            }
            label={
              <Box>
                <Typography variant="body2" fontWeight={700}>
                  Mask money by default
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Visual values become dots and accessible labels say “Amount hidden.”
                </Typography>
              </Box>
            }
          />
          <FormControlLabel
            control={<Switch />}
            label={
              <Box>
                <Typography variant="body2" fontWeight={700}>
                  Reduce motion
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Also follows the operating system reduced-motion preference.
                </Typography>
              </Box>
            }
          />
        </Stack>
      </SettingsCard>
      <SettingsCard title="Formats">
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 3 }}>
          <FormControl size="small">
            <InputLabel id="number-format">Number format</InputLabel>
            <Select labelId="number-format" label="Number format" value="us">
              <MenuItem value="us">1,234.56</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small">
            <InputLabel id="date-format">Date format</InputLabel>
            <Select labelId="date-format" label="Date format" value="mdy">
              <MenuItem value="mdy">Jul 16, 2026</MenuItem>
            </Select>
          </FormControl>
        </Box>
      </SettingsCard>
    </Stack>
  );
}

function DataSettings() {
  const demo = isDemoMode();
  const exportDownload = useMutation({ mutationFn: api.downloadDataExport });
  const databaseDownload = useMutation({ mutationFn: api.downloadDatabaseBackup });
  return (
    <Stack gap={4}>
      <SettingsCard
        title="Portable data export"
        description="Downloads balances, transactions, rules, budgets, goals, assets, scenarios, and non-secret settings as JSON."
      >
        <Alert severity="warning" sx={{ mb: 3 }}>
          The export contains sensitive financial data and is not encrypted. Store it somewhere
          private.
        </Alert>
        <Button
          variant="contained"
          startIcon={<DownloadRounded />}
          disabled={demo || exportDownload.isPending}
          onClick={() => exportDownload.mutate()}
        >
          {exportDownload.isPending ? "Preparing…" : "Download JSON export"}
        </Button>
        {exportDownload.error instanceof Error ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {exportDownload.error.message}
          </Alert>
        ) : null}
        {exportDownload.data ? (
          <Alert severity="success" sx={{ mt: 3 }}>
            Downloaded {exportDownload.data.filename} (
            {(exportDownload.data.sizeBytes / 1_000).toFixed(1)} KB).
          </Alert>
        ) : null}
      </SettingsCard>
      <SettingsCard
        title="SQLite database backup"
        description="Owners can download a consistent snapshot of the live SQLite database."
      >
        <Stack direction={{ xs: "column", sm: "row" }} gap={2}>
          <Button
            variant="outlined"
            startIcon={<BackupRounded />}
            disabled={demo || databaseDownload.isPending}
            onClick={() => databaseDownload.mutate()}
          >
            {databaseDownload.isPending ? "Preparing…" : "Download database backup"}
          </Button>
        </Stack>
        {databaseDownload.error instanceof Error ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {databaseDownload.error.message}
          </Alert>
        ) : null}
        {databaseDownload.data ? (
          <Alert severity="success" sx={{ mt: 3 }}>
            Downloaded {databaseDownload.data.filename} (
            {(databaseDownload.data.sizeBytes / 1_000_000).toFixed(2)} MB).
          </Alert>
        ) : null}
        <Alert severity="info" sx={{ mt: 4 }}>
          Hot restore is intentionally disabled. To restore safely, stop BetterWealth, keep a copy
          of the current database, place the chosen SQLite backup at the configured{" "}
          <code>DATABASE_URL</code>, run <code>bun run db:migrate</code>, then restart and verify
          diagnostics.
        </Alert>
      </SettingsCard>
      <SettingsCard
        title="Automated server backups"
        description="Use the operator-owned backup command for scheduled, permission-restricted snapshots."
      >
        <Box
          component="code"
          sx={{
            display: "block",
            p: 3,
            borderRadius: 2,
            bgcolor: "action.hover",
            overflowX: "auto",
          }}
        >
          bun run db:backup
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2 }}>
          The bundled systemd timer can run this independently of any browser session.
        </Typography>
      </SettingsCard>
      <SettingsCard
        title="Delete household"
        description="Household deletion is not exposed until step-up authentication, verified export, and recovery-window handling are complete."
      >
        <Alert severity="info">
          Use the data export now if you need portability. Destructive deletion controls are
          disabled in this build.
        </Alert>
        <Button color="error" variant="outlined" disabled sx={{ mt: 3 }}>
          Delete household
        </Button>
      </SettingsCard>
    </Stack>
  );
}

function AuditSettings() {
  const demo = isDemoMode();
  const events = useQuery({
    queryKey: ["audit"],
    queryFn: api.auditEvents,
    initialData: demo
      ? {
          data: [
            {
              id: "audit_demo",
              action: "Transaction approved",
              entityType: "transaction",
              safeDescription: "Corner Table categorized as Dining",
              actorLabel: "Alex",
              createdAt: new Date().toISOString(),
            },
          ],
          page: { cursor: null, hasMore: false },
        }
      : undefined,
    enabled: !demo,
    retry: 1,
  });
  if (events.isPending) return <LoadingCard rows={6} />;
  if (events.isError)
    return (
      <ErrorState message="Audit events could not be loaded." onRetry={() => events.refetch()} />
    );
  return (
    <SettingsCard
      title="Audit log"
      description="Live, sanitized, household-scoped history of important changes."
    >
      {events.data?.data.length ? (
        <Stack divider={<Divider />}>
          {events.data.data.map((event) => (
            <Stack key={event.id} direction="row" alignItems="flex-start" gap={3} sx={{ py: 3 }}>
              <HistoryRounded color="action" />
              <Box sx={{ flex: 1 }}>
                <Typography variant="body2" fontWeight={700}>
                  {event.action}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {event.safeDescription}
                </Typography>
              </Box>
              <Typography variant="caption" color="text.secondary" textAlign="right">
                {event.actorLabel} · {new Date(event.createdAt).toLocaleString()}
              </Typography>
            </Stack>
          ))}
        </Stack>
      ) : (
        <Alert severity="info">No audit events have been recorded yet.</Alert>
      )}
    </SettingsCard>
  );
}

function HealthSettings() {
  const demo = isDemoMode();
  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    initialData: demo
      ? {
          status: "ok" as const,
          version: "0.1.0",
          time: new Date().toISOString(),
          database: "ready" as const,
        }
      : undefined,
    enabled: !demo,
    retry: 1,
  });
  const connections = useQuery({
    queryKey: ["connections"],
    queryFn: api.connections,
    initialData: demo ? { data: [], page: { cursor: null, hasMore: false } } : undefined,
    enabled: !demo,
    retry: 1,
  });
  if (health.isPending || connections.isPending) return <LoadingCard rows={6} />;
  if (health.isError || !health.data)
    return (
      <ErrorState
        message="Health diagnostics could not be loaded."
        onRetry={() => health.refetch()}
      />
    );
  const simpleFinConnections =
    connections.data?.data.filter((connection) => connection.provider === "simplefin") ?? [];
  const connectionStatus = !simpleFinConnections.length
    ? "Not configured"
    : simpleFinConnections.every((connection) => connection.status === "healthy")
      ? "Healthy"
      : "Attention";
  const rows = [
    ["Web application", "Healthy", `Version ${health.data.version}`],
    [
      "API",
      health.data.status === "ok" ? "Healthy" : "Attention",
      `Checked ${new Date(health.data.time).toLocaleString()}`,
    ],
    ["Database", health.data.database === "ready" ? "Healthy" : "Attention", health.data.database],
    [
      "Background worker",
      "Not probed",
      "This endpoint verifies the API process and database, not worker liveness",
    ],
    [
      "SimpleFIN connection",
      connectionStatus,
      simpleFinConnections.length
        ? `${simpleFinConnections.length} configured connection${simpleFinConnections.length === 1 ? "" : "s"}`
        : "Connect SimpleFIN from Integrations",
    ],
    ["Database backup", "On demand", "Generate and verify a backup from Data & backups"],
  ] as const;
  return (
    <Stack gap={4}>
      <Alert severity="success" icon={<CheckCircleRounded />}>
        <strong>The API and database responded.</strong> Items that are not directly probed are
        labeled explicitly; no secret or financial payload is included here.
      </Alert>
      <SettingsCard
        title="Runtime diagnostics"
        description="Safe operational details for a self-hosted installation."
      >
        <Stack divider={<Divider />}>
          {rows.map(([name, status, detail]) => (
            <Stack key={name} direction="row" alignItems="center" gap={3} sx={{ py: 3 }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: 8,
                  bgcolor:
                    status === "Healthy"
                      ? "success.main"
                      : status === "Attention"
                        ? "warning.main"
                        : "text.disabled",
                }}
              />
              <Box sx={{ flex: 1 }}>
                <Typography variant="body2" fontWeight={700}>
                  {name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {detail}
                </Typography>
              </Box>
              <StatusChip
                label={status}
                tone={
                  status === "Healthy" ? "positive" : status === "Attention" ? "warning" : "neutral"
                }
              />
            </Stack>
          ))}
        </Stack>
        <Button
          variant="outlined"
          startIcon={<RefreshRounded />}
          onClick={() => {
            void health.refetch();
            void connections.refetch();
          }}
          sx={{ mt: 4 }}
        >
          Run health check
        </Button>
      </SettingsCard>
      <SettingsCard
        title="Support bundle"
        description="Sanitized diagnostic bundle generation is not available yet."
      >
        <Alert severity="info">
          Use the live health check above and server logs for diagnostics.
        </Alert>
        <Button variant="outlined" startIcon={<CodeRounded />} disabled sx={{ mt: 3 }}>
          Create sanitized bundle
        </Button>
      </SettingsCard>
    </Stack>
  );
}

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSection = searchParams.get("section");
  const [section, setSectionState] = useState(
    requestedSection && settingsNavigation.some((item) => item.id === requestedSection)
      ? requestedSection
      : "profile",
  );
  useEffect(() => {
    setSectionState(
      requestedSection && settingsNavigation.some((item) => item.id === requestedSection)
        ? requestedSection
        : "profile",
    );
  }, [requestedSection]);
  const setSection = (id: string) => {
    setSectionState(id);
    setSearchParams(id === "profile" ? {} : { section: id });
  };
  const selectedLabel = settingsNavigation.find((item) => item.id === section)?.label ?? "Settings";
  return (
    <Stack gap={5}>
      <PageHeader
        eyebrow="Settings"
        title={selectedLabel}
        description="Household controls, privacy choices, providers, security, and portable data operations."
      />
      <FormControl fullWidth size="small" sx={{ display: { xs: "flex", md: "none" } }}>
        <InputLabel id="settings-section-label">Settings section</InputLabel>
        <Select
          labelId="settings-section-label"
          label="Settings section"
          value={section}
          onChange={(event) => setSection(event.target.value)}
        >
          {settingsNavigation.map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {item.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "220px minmax(0, 1fr)" },
          gap: 5,
          alignItems: "start",
        }}
      >
        <Card sx={{ display: { xs: "none", md: "block" }, position: "sticky", top: 100 }}>
          <List disablePadding sx={{ p: 2 }}>
            {settingsNavigation.map((item) => {
              const Icon = item.icon;
              return (
                <ListItem key={item.id} disablePadding>
                  <ListItemButton
                    selected={section === item.id}
                    onClick={() => setSection(item.id)}
                    sx={{ minHeight: 44, borderRadius: 2.5 }}
                  >
                    <ListItemIcon sx={{ minWidth: 36 }}>
                      <Icon sx={{ fontSize: 19 }} />
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
        </Card>
        <Box sx={{ minWidth: 0 }}>
          {section === "profile" ? <ProfileSettings /> : null}
          {section === "household" ? <HouseholdSettings /> : null}
          {section === "currencies" ? <CurrencySettings /> : null}
          {section === "integrations" ? <IntegrationsSettings /> : null}
          {section === "security" ? <SecuritySettings /> : null}
          {section === "appearance" ? <AppearanceSettings /> : null}
          {section === "data" ? <DataSettings /> : null}
          {section === "audit" ? <AuditSettings /> : null}
          {section === "health" ? <HealthSettings /> : null}
        </Box>
      </Box>
    </Stack>
  );
}
