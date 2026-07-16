import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowForwardRounded,
  AutoGraphRounded,
  CheckCircleRounded,
  LockRounded,
  VisibilityOffRounded,
  VisibilityRounded,
} from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Paper,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type UseFormRegisterReturn, useForm } from "react-hook-form";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import * as z from "zod";
import { ApiError, api } from "../api";
import { Stack, TextField, Typography } from "../components/mui";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(12, "Password must be at least 12 characters"),
});

const registerSchema = loginSchema.extend({
  householdName: z.string().min(2, "Give your household a name"),
  accepted: z
    .boolean()
    .refine(Boolean, { message: "Confirm you understand this is an educational planning tool" }),
});

type LoginInput = z.infer<typeof loginSchema>;
type RegisterInput = z.infer<typeof registerSchema>;

function BrandMark() {
  return (
    <Stack direction="row" alignItems="center" gap={2}>
      <Box
        sx={{
          width: 34,
          height: 34,
          borderRadius: 2.5,
          color: "#fff",
          display: "grid",
          placeItems: "center",
          fontWeight: 800,
          background: "linear-gradient(140deg, #1F3A5F, #1F9D72)",
        }}
      >
        B
      </Box>
      <Typography sx={{ fontSize: 17, fontWeight: 760, letterSpacing: "-0.025em" }}>
        BetterWealth
      </Typography>
    </Stack>
  );
}

function AuthAside() {
  return (
    <Box
      sx={{
        display: { xs: "none", md: "flex" },
        position: "relative",
        overflow: "hidden",
        flexDirection: "column",
        justifyContent: "space-between",
        p: 10,
        color: "#fff",
        background: "linear-gradient(145deg, #142943 0%, #1A4655 55%, #147657 130%)",
      }}
    >
      <Box
        aria-hidden
        sx={{
          position: "absolute",
          width: 420,
          height: 420,
          borderRadius: "50%",
          border: "1px solid rgba(255,255,255,.08)",
          top: -150,
          right: -120,
          boxShadow: "0 0 0 60px rgba(255,255,255,.025), 0 0 0 120px rgba(255,255,255,.018)",
        }}
      />
      <Box sx={{ position: "relative" }}>
        <Typography variant="overline" sx={{ color: "rgba(255,255,255,.65)" }}>
          A plan you can explain
        </Typography>
        <Typography
          component="p"
          sx={{
            mt: 3,
            maxWidth: 470,
            fontSize: "2.65rem",
            lineHeight: 1.1,
            letterSpacing: "-0.045em",
            fontWeight: 720,
          }}
        >
          Know what’s safe today—and where it leads tomorrow.
        </Typography>
        <Typography sx={{ mt: 4, maxWidth: 460, color: "rgba(255,255,255,.7)", lineHeight: 1.65 }}>
          BetterWealth connects each paycheck to your real obligations, goals, and long-term path
          without hiding the math.
        </Typography>
      </Box>
      <Paper
        elevation={0}
        sx={{
          position: "relative",
          p: 5,
          color: "#fff",
          bgcolor: "rgba(255,255,255,.09)",
          border: "1px solid rgba(255,255,255,.13)",
          backdropFilter: "blur(12px)",
        }}
      >
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="caption" sx={{ color: "rgba(255,255,255,.65)" }}>
              Illustrative wealth path at age 30
            </Typography>
            <Typography
              sx={{ mt: 1, fontSize: 29, fontWeight: 720, fontVariantNumeric: "tabular-nums" }}
            >
              $223,400
            </Typography>
            <Typography
              variant="caption"
              sx={{ display: "block", mt: 1, color: "rgba(255,255,255,.65)" }}
            >
              Example scenario · not your forecast
            </Typography>
          </Box>
          <Box
            sx={{
              width: 44,
              height: 44,
              borderRadius: 3,
              display: "grid",
              placeItems: "center",
              bgcolor: "rgba(255,255,255,.12)",
            }}
          >
            <AutoGraphRounded />
          </Box>
        </Stack>
        <Stack direction="row" alignItems="flex-end" gap={1} sx={{ height: 70, mt: 4 }} aria-hidden>
          {[22, 27, 33, 40, 47, 55, 64, 75, 88, 100].map((height, index) => (
            <Box
              key={height}
              sx={{
                flex: 1,
                height: `${height}%`,
                bgcolor: index > 6 ? "#55D6A7" : "rgba(255,255,255,.2)",
                borderRadius: "3px 3px 1px 1px",
              }}
            />
          ))}
        </Stack>
        <Stack direction="row" gap={3} sx={{ mt: 4 }}>
          {["Private by design", "Explainable math", "Uses your inputs"].map((item) => (
            <Stack key={item} direction="row" gap={1} alignItems="center">
              <CheckCircleRounded sx={{ fontSize: 16, color: "#68DFB3" }} />
              <Typography variant="caption" sx={{ color: "rgba(255,255,255,.75)" }}>
                {item}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </Paper>
    </Box>
  );
}

function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "grid",
        gridTemplateColumns: { xs: "1fr", md: "minmax(480px, 0.92fr) minmax(500px, 1.08fr)" },
        bgcolor: "background.default",
      }}
    >
      <Box
        sx={{ p: { xs: 4, sm: 7, lg: 10 }, display: "flex", flexDirection: "column", minWidth: 0 }}
      >
        <BrandMark />
        <Box sx={{ width: "100%", maxWidth: 440, mx: "auto", my: "auto", py: { xs: 10, sm: 14 } }}>
          {children}
        </Box>
        <Typography variant="caption" color="text.secondary">
          Educational planning estimates, not financial advice.
        </Typography>
      </Box>
      <AuthAside />
    </Box>
  );
}

function PasswordField({
  label,
  error,
  helperText,
  registration,
  autoComplete = "current-password",
}: {
  label: string;
  error: boolean;
  helperText?: string | undefined;
  registration: UseFormRegisterReturn<"password">;
  autoComplete?: "current-password" | "new-password";
}) {
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      label={label}
      type={visible ? "text" : "password"}
      autoComplete={autoComplete}
      fullWidth
      error={error}
      helperText={helperText}
      {...registration}
      InputProps={{
        endAdornment: (
          <InputAdornment position="end">
            <IconButton
              aria-label={visible ? "Hide password" : "Show password"}
              onClick={() => setVisible(!visible)}
              edge="end"
            >
              {visible ? <VisibilityOffRounded /> : <VisibilityRounded />}
            </IconButton>
          </InputAdornment>
        ),
      }}
    />
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const capabilities = useQuery({
    queryKey: ["capabilities"],
    queryFn: api.capabilities,
    retry: 1,
    staleTime: 5 * 60_000,
  });
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });
  const login = useMutation({
    mutationFn: (input: LoginInput) => {
      window.sessionStorage.removeItem("bw-demo");
      return api.login(input);
    },
    onSuccess: ({ user }) => {
      navigate("/today", { replace: true });
      queryClient.setQueryData(["session"], { user, householdId: "" });
      void queryClient.invalidateQueries({ queryKey: ["session"] });
    },
  });
  const errorMessage =
    login.error instanceof ApiError
      ? login.error.message
      : login.error
        ? "Sign in could not be completed."
        : null;

  const exploreDemo = () => {
    window.sessionStorage.setItem("bw-demo", "true");
    navigate("/today");
  };

  return (
    <AuthLayout>
      <Typography component="h1" variant="h1">
        Welcome back
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 2 }}>
        Continue to your household’s plan and latest numbers.
      </Typography>
      {errorMessage ? (
        <Alert severity="error" sx={{ mt: 4 }}>
          {errorMessage}
        </Alert>
      ) : null}
      <Stack
        component="form"
        noValidate
        onSubmit={handleSubmit((input) => login.mutate(input))}
        gap={4}
        sx={{ mt: 7 }}
      >
        <TextField
          label="Email address"
          type="email"
          autoComplete="email"
          fullWidth
          error={Boolean(errors.email)}
          helperText={errors.email?.message}
          {...register("email")}
        />
        <PasswordField
          label="Password"
          error={Boolean(errors.password)}
          helperText={errors.password?.message}
          registration={register("password")}
        />
        <Typography variant="caption" color="text.secondary" textAlign="right">
          Self-hosted password recovery is performed from the server CLI.
        </Typography>
        <Button
          type="submit"
          variant="contained"
          size="large"
          endIcon={<ArrowForwardRounded />}
          disabled={login.isPending}
        >
          {login.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </Stack>
      <Button fullWidth variant="outlined" color="inherit" onClick={exploreDemo} sx={{ mt: 3 }}>
        Explore with Alex’s demo data
      </Button>
      {capabilities.data?.registration.selfService ? (
        <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ mt: 5 }}>
          New to BetterWealth?{" "}
          <RouterLink to="/register" style={{ color: "inherit", fontWeight: 700 }}>
            Create an account
          </RouterLink>
        </Typography>
      ) : capabilities.isPending ? (
        <Typography variant="caption" color="text.secondary" textAlign="center" sx={{ mt: 5 }}>
          Checking this instance’s account policy…
        </Typography>
      ) : (
        <Alert severity="info" sx={{ mt: 5 }}>
          {capabilities.data?.registration.mode === "invite"
            ? "This instance accepts invited accounts only. Ask its operator for access."
            : capabilities.data?.registration.mode === "closed"
              ? "This is a private BetterWealth instance. New account creation is closed."
              : "Account creation availability could not be verified. Existing accounts can still sign in."}
        </Alert>
      )}
    </AuthLayout>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const capabilities = useQuery({
    queryKey: ["capabilities"],
    queryFn: api.capabilities,
    retry: 1,
    staleTime: 5 * 60_000,
  });
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: "", password: "", householdName: "", accepted: false },
  });
  const registerAccount = useMutation({
    mutationFn: async ({ accepted: _accepted, ...input }: RegisterInput) => {
      window.sessionStorage.removeItem("bw-demo");
      await api.register(input);
      return api.login({ email: input.email, password: input.password });
    },
    onSuccess: ({ user }) => {
      navigate("/onboarding", { replace: true });
      queryClient.setQueryData(["session"], { user, householdId: "" });
      void queryClient.invalidateQueries({ queryKey: ["session"] });
    },
  });
  const errorMessage =
    registerAccount.error instanceof ApiError
      ? registerAccount.error.message
      : registerAccount.error
        ? "Your account could not be created."
        : null;

  if (capabilities.isPending) {
    return (
      <AuthLayout>
        <Typography component="h1" variant="h1">
          Checking account policy
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 2 }}>
          Confirming whether this BetterWealth instance accepts new accounts.
        </Typography>
      </AuthLayout>
    );
  }

  if (capabilities.isError || !capabilities.data?.registration.selfService) {
    const mode = capabilities.data?.registration.mode;
    return (
      <AuthLayout>
        <Typography component="h1" variant="h1">
          {mode === "invite"
            ? "An invitation is required"
            : mode === "closed"
              ? "Account creation is closed"
              : "Account policy is unavailable"}
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 2 }}>
          {mode === "invite"
            ? "This instance accepts invited accounts only. Ask its operator for access."
            : mode === "closed"
              ? "This private instance already has its owner account. New accounts are disabled by its operator."
              : "BetterWealth could not safely verify that self-registration is enabled."}
        </Typography>
        {capabilities.isError ? (
          <Button variant="outlined" onClick={() => capabilities.refetch()} sx={{ mt: 5 }}>
            Check again
          </Button>
        ) : null}
        <Button component={RouterLink} to="/login" variant="contained" sx={{ mt: 3 }}>
          Back to sign in
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <Typography component="h1" variant="h1">
        Build your better plan
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 2 }}>
        Start with the facts. Every assumption stays editable.
      </Typography>
      {errorMessage ? (
        <Alert severity="error" sx={{ mt: 4 }}>
          {errorMessage}
        </Alert>
      ) : null}
      <Stack
        component="form"
        noValidate
        onSubmit={handleSubmit((input) => registerAccount.mutate(input))}
        gap={4}
        sx={{ mt: 7 }}
      >
        <TextField
          label="Household name"
          placeholder="Alex's household"
          autoComplete="organization"
          fullWidth
          error={Boolean(errors.householdName)}
          helperText={errors.householdName?.message}
          {...register("householdName")}
        />
        <TextField
          label="Email address"
          type="email"
          autoComplete="email"
          fullWidth
          error={Boolean(errors.email)}
          helperText={errors.email?.message}
          {...register("email")}
        />
        <PasswordField
          label="Create a password"
          error={Boolean(errors.password)}
          helperText={errors.password?.message ?? "Use at least 12 characters."}
          registration={register("password")}
          autoComplete="new-password"
        />
        <FormControlLabel
          control={<Checkbox {...register("accepted")} />}
          label={
            <Typography variant="body2">
              I understand forecasts are educational estimates and can change.
            </Typography>
          }
        />
        {errors.accepted ? (
          <Typography variant="caption" color="error.main" sx={{ mt: -3 }}>
            {errors.accepted.message}
          </Typography>
        ) : null}
        <Button
          type="submit"
          variant="contained"
          size="large"
          endIcon={<LockRounded />}
          disabled={registerAccount.isPending}
        >
          {registerAccount.isPending ? "Creating household…" : "Create secure account"}
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ mt: 5 }}>
        Already have an account?{" "}
        <RouterLink to="/login" style={{ color: "inherit", fontWeight: 700 }}>
          Sign in
        </RouterLink>
      </Typography>
    </AuthLayout>
  );
}
