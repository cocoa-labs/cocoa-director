import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";

// The theme lives on <html data-theme>, applied before paint by the root-layout
// script. We expose it via useSyncExternalStore so the value is read from the DOM
// (client) with a stable "dark" server snapshot — no effect-driven setState and no
// hydration mismatch. Toggles notify all consumers through a tiny listener set.
const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function getServerSnapshot(): Theme {
  return "dark";
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback(() => {
    const next: Theme = getSnapshot() === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage may be unavailable (private mode, blocked) — theme still applies for the session.
    }
    listeners.forEach((onChange) => onChange());
  }, []);

  return { theme, toggle };
}
