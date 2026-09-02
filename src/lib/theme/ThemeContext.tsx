"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { CLAVE_TEMA } from "@/lib/theme/script-inicial";

type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

/*
 * La clave la define `script-inicial.ts`, que es quien la usa primero: el
 * script del <head> corre antes que este módulo exista. Tener la misma cadena
 * escrita en los dos lados es cómo el script termina leyendo una clave que el
 * botón ya no escribe, y el destello vuelve sin que nada falle.
 */
const STORAGE_KEY = CLAVE_TEMA;

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  toggleTheme: () => {},
});

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

/*
 * El tema no vive en React: vive en `<html>` y en `localStorage`.
 *
 * Y esa es la razón de todo lo que sigue. El script del `<head>` ya decidió y
 * ya escribió la clase antes de que este módulo exista; React llega después y
 * lo único que tiene que hacer es LEER lo que ya está, no volver a decidirlo.
 *
 * `useSyncExternalStore` es exactamente para esto, y sobre todo porque toma dos
 * instantáneas distintas: la del servidor —que no puede saber nada, así que
 * dice "light"— y la del cliente. React usa la del servidor para hidratar, así
 * que los dos árboles coinciden, y recién después lee la del cliente y vuelve a
 * renderizar si cambió. Sin advertencia de hidratación y sin un `useEffect` que
 * llame a `setState`, que era la versión anterior de este arreglo y encadenaba
 * un render de más.
 */
const escuchas = new Set<() => void>();

function suscribir(avisar: () => void): () => void {
  escuchas.add(avisar);
  return () => {
    escuchas.delete(avisar);
  };
}

/** Lo que hay puesto ahora, leído de donde la verdad ya está escrita. */
function instantaneaDelCliente(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Lo único que el servidor puede afirmar: nada. El script del <head> corrige. */
function instantaneaDelServidor(): Theme {
  return "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(
    suscribir,
    instantaneaDelCliente,
    instantaneaDelServidor
  );

  const toggleTheme = useCallback(() => {
    const siguiente: Theme = instantaneaDelCliente() === "dark" ? "light" : "dark";
    window.localStorage.setItem(STORAGE_KEY, siguiente);
    applyTheme(siguiente);
    for (const avisar of escuchas) avisar();
  }, []);

  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
