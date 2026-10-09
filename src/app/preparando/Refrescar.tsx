"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const CADA_MS = 5_000;

/** Vuelve a pedir la pantalla cada tanto: el servidor ve si la base ya está lista y redirige. No dibuja nada. */
export function Refrescar() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), CADA_MS);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
