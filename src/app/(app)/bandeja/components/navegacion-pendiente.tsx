"use client";

// One transition for the whole inbox: controls reflect the click instantly
// via `paramsVisibles` (destination while pending, URL otherwise).
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";

interface Navegacion {
  pending: boolean;
  paramsVisibles: URLSearchParams;
  empujar: (url: string) => void;
}

const Ctx = createContext<Navegacion | null>(null);

export function NavegacionPendienteProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [destino, setDestino] = useState<URLSearchParams | null>(null);

  const empujar = useCallback(
    (url: string) => {
      const i = url.indexOf("?");
      setDestino(new URLSearchParams(i === -1 ? "" : url.slice(i + 1)));
      startTransition(() => {
        router.push(url);
      });
    },
    [router]
  );

  const value = useMemo<Navegacion>(
    () => ({
      pending: isPending,
      paramsVisibles: isPending && destino ? destino : searchParams,
      empujar,
    }),
    [isPending, destino, searchParams, empujar]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNavegacion(): Navegacion {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNavegacion: falta NavegacionPendienteProvider");
  return ctx;
}
