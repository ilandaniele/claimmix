/**
 * El historial de eventos del caso.
 *
 * Lo que se prueba acá es `motivoLegible`, que no tenía nada. El historial y el
 * panel de adjuntos se leen en la misma pantalla y para la misma persona: si el
 * panel ya dice «El archivo pesa más de 10 MB» y el historial sigue diciendo
 * «Motivo: size_exceeded», el código interno vuelve a la cara del analista por
 * la otra puerta.
 *
 * La otra rama importa igual: el `reason` del historial no es siempre un
 * código de adjunto. `close-abandoned.ts` cierra con la prosa fija «sin
 * respuesta del denunciante», y eso tiene que pasar tal cual.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

// Sin mock de i18n a propósito: lo que se afirma es el texto que lee una
// persona. Si mañana alguien cambia la frase del rechazo, este test se entera.
import { AuditTimeline } from "@/app/(app)/casos/[id]/components/AuditTimeline";
import { AuditEvent } from "@/lib/audit/log";
import { esAR } from "@/lib/i18n";

// Prefijos y valores exactos que no necesitan traducción propia: son técnicos
// (`auth.`, `health.`, `assistant.`) o entrenamiento/IA que no pasa por acá.
const PREFIJOS_EXCLUIDOS = [
  "auth.",
  "health.",
  "assistant.",
  "training.prompt_rule_",
  "training.custom_field_",
  "training.finetune_",
];
const VALORES_EXCLUIDOS = new Set([
  "agent.memory_config_exported",
  "ai.provider_changed",
  "email.filtered",
  "email.webhook_rejected",
  "email.deduplicated",
  "case.deleted",
]);

const ADJUNTO_RECHAZADO = {
  id: 1,
  event_type: "attachment.rejected",
  created_at: "2026-09-01T10:00:00Z",
  reason: "size_exceeded",
};

const CERRADO_POR_SILENCIO = {
  id: 2,
  event_type: "case.closed",
  created_at: "2026-09-01T10:01:00Z",
  reason: "sin respuesta del denunciante",
};

describe("AuditTimeline", () => {
  it("traduce el código de rechazo de adjunto en vez de pintarlo crudo", () => {
    render(<AuditTimeline events={[ADJUNTO_RECHAZADO]} />);

    expect(screen.getByText(/pesa más de 10 MB/i)).toBeInTheDocument();
    expect(screen.getByText(/mande más chico/i)).toBeInTheDocument();
    // El código interno no llega a la pantalla por ninguna puerta.
    expect(screen.queryByText(/size_exceeded/)).not.toBeInTheDocument();
  });

  // La entrada y la salida de «Para responder»: si falta la clave, el historial
  // pinta «Claim → Message_not_read».
  it("traduce los eventos de «Para responder»", () => {
    render(
      <AuditTimeline
        events={[
          { id: 3, event_type: "claim.message_not_read", created_at: "2026-09-01T10:02:00Z", reason: null },
          { id: 4, event_type: "case.marked_answered", created_at: "2026-09-01T10:03:00Z", reason: null },
        ]}
      />
    );

    expect(screen.getByText("Mensaje que el agente no leyó")).toBeInTheDocument();
    expect(screen.getByText("Marcado como respondido")).toBeInTheDocument();
    expect(screen.queryByText(/→/)).not.toBeInTheDocument();
  });

  it("un motivo escrito en prosa pasa tal cual", () => {
    render(<AuditTimeline events={[CERRADO_POR_SILENCIO]} />);

    expect(
      screen.getByText("sin respuesta del denunciante")
    ).toBeInTheDocument();
  });

  it("todo evento del historial tiene una traducción", () => {
    const valores = [...Object.values(AuditEvent), "case.re_analyze_triggered"];
    for (const v of valores) {
      if (PREFIJOS_EXCLUIDOS.some((p) => v.startsWith(p))) continue;
      if (VALORES_EXCLUIDOS.has(v)) continue;
      expect(esAR).toHaveProperty(`audit.${v}`);
    }
  });

  it("un mensaje de WhatsApp se lee como tal, no como email", () => {
    render(
      <AuditTimeline
        events={[
          { id: 5, event_type: "email.received", created_at: "2026-09-01T10:04:00Z", reason: null },
        ]}
        channel="whatsapp_sim"
      />
    );

    expect(screen.getByText("Llegó un mensaje por WhatsApp")).toBeInTheDocument();
  });

  it("la severidad alta se lee «Severidad: Alto»", () => {
    render(
      <AuditTimeline
        events={[
          { id: 6, event_type: "case.status_changed", created_at: "2026-09-01T10:05:00Z", reason: "severidad high" },
        ]}
      />
    );

    expect(screen.getByText("Severidad: Alto")).toBeInTheDocument();
  });

  it.each([
    ["processing_timeout", "El análisis tardó demasiado"],
    ["conflict", "Un dato no coincide con lo que teníamos"],
    ["lesiones", "Mencionó lesiones o datos de salud"],
  ])("el motivo %s se traduce", (reason, esperado) => {
    render(
      <AuditTimeline
        events={[
          { id: 7, event_type: "case.status_changed", created_at: "2026-09-01T10:06:00Z", reason },
        ]}
      />
    );

    expect(screen.getByText(esperado)).toBeInTheDocument();
  });
});
