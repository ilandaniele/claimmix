"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

interface Props {
  action: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  /** Manda el formulario tal cual (archivos incluidos) en vez de JSON. */
  multipart?: boolean;
  /** Ya traducidos por el servidor: este componente no conoce el idioma. */
  okTexto: string;
  errorTexto: string;
  /** Vacía los campos cuando sale bien (el formulario público no tiene nada que mostrar después). */
  reiniciar?: boolean;
  confirmar?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Un `<form>` que manda sus campos a una ruta de la API y refresca la página.
 *
 * Es lo único que viaja al navegador de los paneles de configuración y del
 * padrón: los campos, las listas y los textos los pinta el servidor. Un nombre
 * que termina en `[]` junta sus valores en un arreglo; «true» y «false» pasan a
 * booleanos. Si la respuesta trae `resumen`, lo muestra línea por línea: así la
 * vista previa de una importación llega ya redactada, sin que el navegador
 * cargue el diccionario.
 */
export function FormularioApi({
  action,
  method,
  multipart,
  okTexto,
  errorTexto,
  reiniciar,
  confirmar,
  className,
  children,
}: Props) {
  const router = useRouter();
  const [estado, setEstado] = useState<{ ok: boolean; lineas: string[] } | "enviando" | null>(null);

  async function enviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (confirmar && !window.confirm(confirmar)) return;
    const formulario = e.currentTarget;
    const quien = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const datos = new FormData(formulario, quien);
    const cuerpo: Record<string, unknown> = {};
    for (const [k, v] of datos) {
      const valor = v === "true" ? true : v === "false" ? false : v;
      if (k.endsWith("[]")) ((cuerpo[k.slice(0, -2)] ??= []) as unknown[]).push(valor);
      else cuerpo[k] = valor;
    }
    setEstado("enviando");
    try {
      // Un botón con `formaction` manda el formulario a su propia ruta (vista previa o importar).
      const res = await fetch(quien?.getAttribute("formaction") ?? action, {
        method,
        ...(multipart
          ? { body: datos }
          : { body: JSON.stringify(cuerpo), headers: { "content-type": "application/json" } }),
      });
      const json = (await res.json().catch(() => null)) as { resumen?: string[] } | null;
      setEstado({ ok: res.ok, lineas: json?.resumen ?? [res.ok ? okTexto : errorTexto] });
      if (res.ok) {
        if (reiniciar) formulario.reset();
        router.refresh();
      }
    } catch {
      setEstado({ ok: false, lineas: [errorTexto] });
    }
  }

  return (
    <form onSubmit={enviar} className={className}>
      <fieldset disabled={estado === "enviando"} className="contents">
        {children}
      </fieldset>
      {estado && estado !== "enviando" && (
        <p
          role={estado.ok ? "status" : "alert"}
          className={`mt-2 whitespace-pre-line text-xs ${estado.ok ? "text-emerald-700" : "text-red-700"}`}
        >
          {estado.lineas.join("\n")}
        </p>
      )}
    </form>
  );
}
