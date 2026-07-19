import { createTheme } from "@mui/material/styles";

export type BetterWealthMode = "light" | "dark";

// Near-stock MUI theme: default palette, shape, typography, shadows, and
// component styles. The single deliberate deviation is `spacing: 4`, because
// numeric `sx` spacing values across the app are calibrated to a 4px unit.
export function createBetterWealthTheme(mode: BetterWealthMode) {
  return createTheme({
    palette: { mode },
    spacing: 4,
  });
}
