import React, { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
interface ThemeContextType { theme: Theme; toggleTheme?: () => void; switchable: boolean; }
const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children, defaultTheme = "light", switchable = false }: { children: React.ReactNode; defaultTheme?: Theme; switchable?: boolean }) {
  const [theme, setTheme] = useState<Theme>(() => {
    if (switchable) return (localStorage.getItem("theme") as Theme) || defaultTheme;
    return defaultTheme;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    if (switchable) localStorage.setItem("theme", theme);
  }, [theme, switchable]);

  const toggleTheme = switchable ? () => setTheme(prev => prev === "light" ? "dark" : "light") : undefined;

  return <ThemeContext.Provider value={{ theme, toggleTheme, switchable }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider");
  return context;
}
