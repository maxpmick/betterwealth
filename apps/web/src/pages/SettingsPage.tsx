import {
  AccountBalanceRounded,
  BackupRounded,
  CheckCircleRounded,
  CloudDownloadRounded,
  CloudSyncRounded,
  CurrencyExchangeRounded,
  DataObjectRounded,
  DevicesRounded,
  DownloadRounded,
  GroupRounded,
  HistoryRounded,
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

const trustedAiProviderHosts = new Set([
  "api.deepinfra.com",
  "api.deepseek.com",
  "api.groq.com",
  "api.mistral.ai",
  "api.openai.com",
  "api.together.xyz",
  "api.x.ai",
  "generativelanguage.googleapis.com",
  "inference.cerebras.ai",
  "openrouter.ai",
]);

function SettingsCard({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent sx={{ p: { xs: 4, sm: 5 } }}>
        <SectionHeader title={title} {...(action ? { action } : {})} />
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
  const [demoSaved, setDemoSaved] = useState(false);
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
      <SettingsCard title="Your profile">
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
              onChange={(event) => {
                setDisplayName(event.target.value);
                setDemoSaved(false);
              }}
            />
            <TextField
              label="Email"
              value={profile.data.user.email}
              type="email"
              inputProps={{ readOnly: true }}
              helperText="Sign-in identifier. A verified email-change workflow is not included in this self-hosted release."
            />
            <TextField
              label="Birth date"
              value={birthDate}
              onChange={(event) => {
                setBirthDate(event.target.value);
                setDemoSaved(false);
              }}
              type="date"
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Target age"
              value={targetAge}
              onChange={(event) => {
                setTargetAge(event.target.value);
                setDemoSaved(false);
              }}
              type="number"
              inputProps={{ min: 18, max: 120 }}
            />
          </Box>
        </Stack>
      </SettingsCard>
      <SettingsCard title="Household plan">
        <Box
          sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)" }, gap: 3 }}
        >
          <TextField
            label="Household name"
            value={householdName}
            disabled={!canManageHousehold}
            onChange={(event) => {
              setHouseholdName(event.target.value);
              setDemoSaved(false);
            }}
          />
          <FormControl size="small" disabled={!canManageHousehold}>
            <InputLabel id="profile-base-currency">Base currency</InputLabel>
            <Select
              labelId="profile-base-currency"
              label="Base currency"
              value={baseCurrency}
              onChange={(event) => {
                setBaseCurrency(event.target.value);
                setDemoSaved(false);
              }}
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
            onChange={(event) => {
              setTimezone(event.target.value);
              setDemoSaved(false);
            }}
            helperText="Use an IANA timezone, such as America/New_York."
          />
          <TextField
            label="Household role"
            value={profile.data.role}
            inputProps={{ readOnly: true }}
          />
        </Box>
        <Alert severity="info" sx={{ mt: 4 }}>
          Birth date and target age set the forecast horizon.
        </Alert>
        {save.error instanceof Error ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {save.error.message}
          </Alert>
        ) : null}
        {save.isSuccess || demoSaved ? (
          <Alert severity="success" sx={{ mt: 3 }}>
            {demo ? "Profile preview updated for this demo session." : "Profile saved."}
          </Alert>
        ) : null}
        <Button
          variant="contained"
          sx={{ mt: 4 }}
          disabled={save.isPending || !displayName.trim() || !householdName.trim()}
          onClick={() => (demo ? setDemoSaved(true) : save.mutate())}
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
      <SettingsCard title="Household members">
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
      <SettingsCard title="Reporting currency">
        <Stack direction="row" alignItems="center" justifyContent="space-between" gap={3}>
          <Box>
            <Typography variant="body2" fontWeight={700}>
              Base / reporting currency
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Change this from Profile & target.
            </Typography>
          </Box>
          <Chip label={profile.data.household.baseCurrency} color="primary" variant="outlined" />
        </Stack>
        <Alert severity="info" sx={{ mt: 3 }}>
          Accounts keep their native currencies. Cross-currency totals are omitted without verified
          exchange-rate data.
        </Alert>
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
    <Box sx={{ p: 4, border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
      <Stack direction="row" gap={3} alignItems="flex-start">
        <Box
          sx={{
            width: 42,
            height: 42,
            flex: "0 0 auto",
            borderRadius: 1,
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
            <Typography variant="subtitle1">{title}</Typography>
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
          {onAction ? (
            <Button variant="outlined" sx={{ mt: 3 }} onClick={onAction}>
              {action}
            </Button>
          ) : (
            <Chip label={action} size="small" variant="outlined" sx={{ mt: 3 }} />
          )}
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
    model: "minimax/minimax-m3",
    confidenceThreshold: 0.9,
    webResearchEnabled: false,
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
  const [aiWebResearchEnabled, setAiWebResearchEnabled] = useState(false);
  const [simpleFinOpen, setSimpleFinOpen] = useState(false);
  const [setupToken, setSetupToken] = useState("");
  const closeAiConfig = () => {
    setAiConfigOpen(false);
    setAiKey("");
    setAiConsent(Boolean(settings.data?.ai.enabled));
    setAiWebResearchEnabled(Boolean(aiConfig.data?.webResearchEnabled));
  };
  useEffect(() => setAiConsent(Boolean(settings.data?.ai.enabled)), [settings.data?.ai.enabled]);
  useEffect(() => {
    if (!aiConfig.data) return;
    setAiBaseUrl(aiConfig.data.baseUrl);
    setAiModel(aiConfig.data.model ?? "");
    setAiThreshold(String(Math.round(aiConfig.data.confidenceThreshold * 100)));
    setAiWebResearchEnabled(Boolean(aiConfig.data.webResearchEnabled));
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
        webResearchEnabled: aiWebResearchEnabled,
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
    validAiUrl =
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      trustedAiProviderHosts.has(parsed.hostname.toLowerCase());
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
      <SettingsCard title="Financial data">
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
      <SettingsCard title="Optional providers">
        <Stack gap={3}>
          <IntegrationCard
            icon={<SmartToyRounded />}
            title="Supported AI providers"
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
            icon={<AccountBalanceRounded />}
            title="Asset valuations"
            description="Record dated manual value points for homes, vehicles, and other assets in Net worth."
            status="Manual"
            action="Use Net worth"
            onAction={() => navigate("/net-worth")}
          />
        </Stack>
      </SettingsCard>
      <SettingsCard title="AI consent & field disclosure">
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
        <Box sx={{ mt: 4, p: 4, borderRadius: 1, bgcolor: "action.hover" }}>
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
              ...(aiConfig.data?.webResearchEnabled ? ["Public merchant web research"] : []),
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
              {demo
                ? "This applies an in-browser preview only. Sign in to encrypt and store a provider key."
                : "The key is sent only to your BetterWealth API, encrypted at rest, and never returned. Provider requests use the consented transaction fields listed on this page."}
            </Alert>
            <TextField
              label="Supported AI provider base URL"
              type="url"
              value={aiBaseUrl}
              onChange={(event) => setAiBaseUrl(event.target.value)}
              error={Boolean(aiBaseUrl) && !validAiUrl}
              helperText={
                validAiUrl
                  ? "Trusted public provider host. Requests are restricted to this exact host."
                  : "Use HTTPS with OpenRouter, OpenAI, Groq, Together, DeepInfra, Mistral, DeepSeek, Google, Cerebras, or xAI."
              }
              fullWidth
            />
            <TextField
              label="Model"
              value={aiModel}
              onChange={(event) => setAiModel(event.target.value)}
              placeholder="minimax/minimax-m3"
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
            <FormControlLabel
              sx={{ alignItems: "flex-start", m: 0 }}
              control={
                <Switch
                  checked={aiWebResearchEnabled}
                  onChange={(event) => setAiWebResearchEnabled(event.target.checked)}
                  inputProps={{
                    "aria-label": "Automatically research uncertain merchants on the public web",
                  }}
                />
              }
              label={
                <Box sx={{ pt: 0.5 }}>
                  <Typography variant="body2" fontWeight={700}>
                    Automatically research uncertain merchants on the public web
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Only the merchant name or statement descriptor may be used as the public search
                    query—never the amount, account, or personal details. OpenRouter may charge
                    separately for web search.
                  </Typography>
                </Box>
              }
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
            {saveAiConfig.isPending
              ? "Saving…"
              : demo
                ? "Apply configuration preview"
                : "Save encrypted configuration"}
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
          ) : demo ? (
            <Alert severity="info">
              Sign in to connect SimpleFIN. Credentials are never accepted or retained by the
              read-only example session.
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
          {!simpleFin && !demo ? (
            <Button
              variant="contained"
              disabled={!setupToken.trim() || claim.isPending}
              onClick={() => claim.mutate()}
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
      <SettingsCard title="Change password">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Changing your password revokes every other active session.
        </Typography>
        {demo ? (
          <Alert severity="info">
            Password changes apply to a signed-in self-hosted account, not this example session.
          </Alert>
        ) : (
          <>
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
              onClick={() => password.mutate()}
              sx={{ mt: 4 }}
            >
              {password.isPending ? "Changing…" : "Change password"}
            </Button>
          </>
        )}
      </SettingsCard>
      <SettingsCard title="Active sessions">
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
              ) : !demo ? (
                <Button
                  color="error"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(session.id)}
                >
                  Revoke
                </Button>
              ) : null}
            </Stack>
          ))}
        </Stack>
        {revoke.error instanceof Error ? (
          <Alert severity="error" sx={{ mt: 3 }}>
            {revoke.error.message}
          </Alert>
        ) : null}
        {!demo && sessions.some((session) => !session.current) ? (
          <Button
            color="error"
            variant="outlined"
            disabled={revoke.isPending}
            onClick={() => {
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
        ) : null}
      </SettingsCard>
    </Stack>
  );
}

function AppearanceSettings() {
  const { preference, setPreference } = useAppearance();
  const { privacyEnabled, setPrivacyEnabled } = usePrivacy();
  return (
    <Stack gap={4}>
      <SettingsCard title="Theme">
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
      </SettingsCard>
      <SettingsCard title="Privacy">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Display preferences are stored on this device and applied immediately.
        </Typography>
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
      <SettingsCard title="Portable data export">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Includes balances, transactions, rules, budgets, goals, assets, scenarios, and non-secret
          settings as JSON.
        </Typography>
        <Alert severity="warning" sx={{ mb: 3 }}>
          The export contains sensitive financial data and is not encrypted. Store it somewhere
          private.
        </Alert>
        {demo ? (
          <Alert severity="info">
            Exports apply to your live self-hosted household, not example data.
          </Alert>
        ) : (
          <Button
            variant="contained"
            startIcon={<DownloadRounded />}
            disabled={exportDownload.isPending}
            onClick={() => exportDownload.mutate()}
          >
            {exportDownload.isPending ? "Preparing…" : "Download JSON export"}
          </Button>
        )}
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
      <SettingsCard title="SQLite database backup">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Owners can download a consistent snapshot of the live SQLite database.
        </Typography>
        {demo ? (
          <Alert severity="info">Database snapshots apply to a live self-hosted instance.</Alert>
        ) : (
          <Stack direction={{ xs: "column", sm: "row" }} gap={2}>
            <Button
              variant="outlined"
              startIcon={<BackupRounded />}
              disabled={databaseDownload.isPending}
              onClick={() => databaseDownload.mutate()}
            >
              {databaseDownload.isPending ? "Preparing…" : "Download database backup"}
            </Button>
          </Stack>
        )}
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
          Restore is an offline operator procedure: stop BetterWealth, keep a copy of the current
          database, place the chosen SQLite backup at the configured <code>DATABASE_URL</code>, run{" "}
          <code>bun run db:migrate</code>, then restart and verify diagnostics.
        </Alert>
      </SettingsCard>
      <SettingsCard title="Automated server backups">
        <Box
          component="code"
          sx={{
            display: "block",
            p: 3,
            borderRadius: 1,
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
    <SettingsCard title="Audit log">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Sanitized, household-scoped history of important changes.
      </Typography>
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
      <SettingsCard title="Runtime diagnostics">
        <Stack divider={<Divider />}>
          {rows.map(([name, status, detail]) => (
            <Stack key={name} direction="row" alignItems="center" gap={3} sx={{ py: 3 }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
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
      <PageHeader title={selectedLabel} />
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
                    sx={{ minHeight: 44, borderRadius: 1 }}
                  >
                    <ListItemIcon sx={{ minWidth: 36 }}>
                      <Icon />
                    </ListItemIcon>
                    <ListItemText primary={item.label} />
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
