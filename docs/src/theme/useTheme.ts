import { useContext } from "react";
import { ThemeContext } from "./theme-context";
import type { ThemeContextValue } from "./theme-context";

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("useTheme must be used within a <ThemeProvider>");
  }
  return value;
}
