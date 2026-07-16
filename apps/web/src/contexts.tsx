import { CssBaseline, ThemeProvider, useMediaQuery } from "@mui/material";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { type BetterWealthMode, createBetterWealthTheme } from "./theme";

export type ThemePreference = "light" | "dark" | "system";

interface PrivacyContextValue {
  privacyEnabled: boolean;
  setPrivacyEnabled: (enabled: boolean) => void;
}

interface AppearanceContextValue {
  preference: ThemePreference;
  setPreference: (mode: ThemePreference) => void;
  resolvedMode: BetterWealthMode;
}

const PrivacyContext = createContext<PrivacyContextValue | null>(null);
const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function readStorage<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readStorage("bw-theme", ["light", "dark", "system"] as const, "system"),
  );
  const [privacyEnabled, setPrivacyState] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem("bw-privacy") === "true",
  );
  const resolvedMode: BetterWealthMode =
    preference === "system" ? (prefersDark ? "dark" : "light") : preference;
  const theme = useMemo(() => createBetterWealthTheme(resolvedMode), [resolvedMode]);

  const setPreference = (mode: ThemePreference) => {
    setPreferenceState(mode);
    window.localStorage.setItem("bw-theme", mode);
  };
  const setPrivacyEnabled = (enabled: boolean) => {
    setPrivacyState(enabled);
    window.localStorage.setItem("bw-privacy", String(enabled));
  };

  useEffect(() => {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", resolvedMode === "dark" ? "#0B1017" : "#F7F7F5");
  }, [resolvedMode]);

  const privacy = useMemo(() => ({ privacyEnabled, setPrivacyEnabled }), [privacyEnabled]);
  const appearance = useMemo(
    () => ({ preference, setPreference, resolvedMode }),
    [preference, resolvedMode],
  );

  return (
    <AppearanceContext.Provider value={appearance}>
      <PrivacyContext.Provider value={privacy}>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          {children}
        </ThemeProvider>
      </PrivacyContext.Provider>
    </AppearanceContext.Provider>
  );
}

export function usePrivacy() {
  const value = useContext(PrivacyContext);
  if (!value) throw new Error("usePrivacy must be used inside AppProviders");
  return value;
}

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance must be used inside AppProviders");
  return value;
}
