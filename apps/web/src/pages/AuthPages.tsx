import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowForwardRounded,
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
          borderRadius: 1,
          color: "#fff",
          display: "grid",
          placeItems: "center",
          fontWeight: 700,
          bgcolor: "primary.main",
        }}
      >
        B
      </Box>
      <Typography variant="h6">BetterWealth</Typography>
    </Stack>
  );
}

function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        p: { xs: 4, sm: 7 },
        bgcolor: "background.default",
      }}
    >
      <BrandMark />
      <Box sx={{ width: "100%", maxWidth: 440, mx: "auto", my: "auto", py: { xs: 10, sm: 14 } }}>
        {children}
      </Box>
      <Typography variant="caption" color="text.secondary">
        Educational planning estimates, not financial advice.
      </Typography>
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
      <Typography component="h1" variant="h4">
        Welcome back
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
          {capabilities.data?.registration.mode === "closed"
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
        <Typography component="h1" variant="h4">
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
        <Typography component="h1" variant="h4">
          {mode === "closed" ? "Account creation is closed" : "Account policy is unavailable"}
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 2 }}>
          {mode === "closed"
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
      <Typography component="h1" variant="h4">
        Create your account
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
          {registerAccount.isPending ? "Creating household…" : "Create account"}
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
