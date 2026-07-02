import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { DEFAULT_THEME, nextTheme, PALETTES, type Palette, type ThemeId } from "./palettes";

interface ThemeContextValue {
  themeId: ThemeId;
  palette: Palette;
  /** advance to the next of the three Warm schemes (on-device switcher) */
  cycle: () => void;
  setTheme: (id: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeId] = useState<ThemeId>(DEFAULT_THEME);
  const cycle = useCallback(() => setThemeId((id) => nextTheme(id)), []);
  const value = useMemo<ThemeContextValue>(
    () => ({ themeId, palette: PALETTES[themeId], cycle, setTheme: setThemeId }),
    [themeId, cycle],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
