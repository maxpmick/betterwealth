import { alpha, createTheme, responsiveFontSizes } from "@mui/material/styles";

export type BetterWealthMode = "light" | "dark";

export function createBetterWealthTheme(mode: BetterWealthMode) {
  const isDark = mode === "dark";
  const background = isDark ? "#0B1017" : "#F7F7F5";
  const paper = isDark ? "#111923" : "#FFFFFF";
  const text = isDark ? "#F3F6F8" : "#151A22";
  const divider = isDark ? "rgba(255,255,255,0.09)" : "rgba(21,26,34,0.09)";

  return responsiveFontSizes(
    createTheme({
      palette: {
        mode,
        primary: { main: isDark ? "#86A9D5" : "#1F3A5F", contrastText: "#FFFFFF" },
        secondary: {
          main: isDark ? "#79DDB8" : "#075C40",
          contrastText: isDark ? "#151A22" : "#FFFFFF",
        },
        success: {
          main: isDark ? "#79DDB8" : "#075C40",
          contrastText: isDark ? "#151A22" : "#FFFFFF",
        },
        warning: {
          main: isDark ? "#F2BA72" : "#7A4307",
          contrastText: isDark ? "#151A22" : "#FFFFFF",
        },
        error: {
          main: isDark ? "#F29A94" : "#8E2D29",
          contrastText: isDark ? "#151A22" : "#FFFFFF",
        },
        info: {
          main: isDark ? "#9CC2F2" : "#244F86",
          contrastText: isDark ? "#151A22" : "#FFFFFF",
        },
        background: { default: background, paper },
        text: { primary: text, secondary: isDark ? "#9CAABD" : "#68717E" },
        divider,
      },
      shape: { borderRadius: 10 },
      spacing: 4,
      typography: {
        fontFamily:
          '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        h1: { fontSize: "2rem", fontWeight: 720, letterSpacing: "-0.035em", lineHeight: 1.14 },
        h2: { fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.025em", lineHeight: 1.2 },
        h3: { fontSize: "1.08rem", fontWeight: 680, letterSpacing: "-0.012em", lineHeight: 1.3 },
        subtitle1: { fontSize: "0.95rem", fontWeight: 650 },
        body1: { fontSize: "0.925rem", lineHeight: 1.55 },
        body2: { fontSize: "0.825rem", lineHeight: 1.5 },
        button: {
          fontSize: "0.825rem",
          fontWeight: 660,
          letterSpacing: "-0.005em",
          textTransform: "none",
        },
        caption: { fontSize: "0.73rem", lineHeight: 1.45, letterSpacing: "0.005em" },
        overline: {
          fontSize: "0.68rem",
          lineHeight: 1.5,
          fontWeight: 750,
          letterSpacing: "0.09em",
        },
      },
      components: {
        MuiCssBaseline: {
          styleOverrides: {
            ":root": { colorScheme: mode },
            "*": { boxSizing: "border-box" },
            html: { minWidth: 320, backgroundColor: background, scrollBehavior: "smooth" },
            body: { margin: 0, minWidth: 320, minHeight: "100vh", backgroundColor: background },
            "#root": { minHeight: "100vh" },
            "::selection": { background: alpha("#1F9D72", 0.25) },
            ":focus-visible": { outline: `3px solid ${alpha("#4A7FD1", 0.52)}`, outlineOffset: 2 },
            "@media (prefers-reduced-motion: reduce)": {
              "*, *::before, *::after": {
                animationDuration: "0.01ms !important",
                transitionDuration: "0.01ms !important",
                scrollBehavior: "auto !important",
              },
            },
          },
        },
        MuiPaper: {
          styleOverrides: {
            root: { backgroundImage: "none" },
            rounded: { borderRadius: 14 },
          },
        },
        MuiCard: {
          styleOverrides: {
            root: {
              borderRadius: 14,
              border: `1px solid ${divider}`,
              boxShadow: isDark
                ? "0 16px 44px rgba(0,0,0,0.15)"
                : "0 12px 34px rgba(27,34,44,0.045)",
              backgroundImage: "none",
            },
          },
        },
        MuiButton: {
          defaultProps: { disableElevation: true },
          styleOverrides: {
            root: { minHeight: 44, borderRadius: 10, paddingInline: 16 },
            contained: { boxShadow: "0 4px 14px rgba(31,58,95,0.18)" },
          },
        },
        MuiIconButton: {
          styleOverrides: { root: { width: 44, height: 44, borderRadius: 10 } },
        },
        MuiChip: {
          styleOverrides: {
            root: { height: 28, borderRadius: 8, fontWeight: 620 },
            label: { paddingInline: 9 },
          },
        },
        MuiTextField: {
          defaultProps: { size: "small" },
        },
        MuiOutlinedInput: {
          styleOverrides: {
            root: {
              minHeight: 44,
              borderRadius: 10,
              backgroundColor: alpha(paper, isDark ? 0.4 : 0.72),
            },
            notchedOutline: { borderColor: divider },
          },
        },
        MuiTooltip: { defaultProps: { arrow: true, enterTouchDelay: 350 } },
        MuiDialog: { styleOverrides: { paper: { borderRadius: 18 } } },
        MuiDrawer: { styleOverrides: { paper: { backgroundImage: "none" } } },
        MuiLinearProgress: {
          styleOverrides: { root: { height: 7, borderRadius: 99 }, bar: { borderRadius: 99 } },
        },
        MuiTableCell: { styleOverrides: { root: { borderColor: divider } } },
      },
    }),
  );
}
