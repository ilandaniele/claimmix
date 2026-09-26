/**
 * El panel donde el analista ve qué mandó el asegurado.
 *
 * Desde que un archivo de WhatsApp que pasa el tope de 10 MB deja igual su fila
 * en `claim_attachments` —sin `storage_path` y con `rejected_reason`—, el panel
 * tiene que pintar dos cosas distintas y no una. Antes la rechazada se veía
 * IGUAL que una guardada, y el tamaño era el que más mentía: cuando la
 * metadata no trae `file_size`, la descarga se corta a mitad del cuerpo y
 * nadie cuenta los bytes, así que el llamador escribe
 * `MAX_ATTACHMENT_SIZE_BYTES + 1` como centinela y la pantalla lo pintaba
 * «10.0 MB». Un video de 80 MB se leía como que se pasó por un byte.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

// Sin mock de i18n a propósito: lo que se afirma es el texto que lee una
// persona. Si mañana alguien cambia la frase del rechazo, este test se entera.
import { AttachmentsPanel } from "@/app/(app)/casos/[id]/_components/AttachmentsPanel";

const GUARDADO = {
  id: "a-1",
  filename: "frente.jpg",
  content_type: "image/jpeg",
  size_bytes: 204800,
  external_url: "https://ejemplo.test/frente.jpg",
  uploaded_at: "2026-09-01T10:00:00Z",
  rejected_reason: null,
  disponible: true,
  matched_doc_key: null,
};

const RECHAZADO = {
  id: "a-2",
  filename: "video-del-choque.mp4",
  content_type: "video/mp4",
  // El centinela, tal cual lo escribe `intake-agent.ts` cuando no hubo bytes.
  size_bytes: 10 * 1024 * 1024 + 1,
  external_url: "",
  uploaded_at: "2026-09-01T10:01:00Z",
  rejected_reason: "size_exceeded",
  disponible: false,
  matched_doc_key: null,
};

// Sin `external_url` a propósito: ese branch ya pone su propio «Abrir», y lo
// que prueban estos casos es el link nuevo, el que sirve el archivo propio.
const PROPIO = { ...GUARDADO, external_url: "" };

describe("AttachmentsPanel", () => {
  it("el rechazado explica por qué no entró y qué pedirle al asegurado", () => {
    render(<AttachmentsPanel attachments={[GUARDADO, RECHAZADO]} caseId="c-1" puedeAbrir={false} />);

    expect(screen.getByText(/pesa más de 10 MB/i)).toBeInTheDocument();
    expect(screen.getByText(/mande más chico/i)).toBeInTheDocument();
  });

  it("no pinta el tamaño del rechazado: ese número es un centinela", () => {
    render(<AttachmentsPanel attachments={[GUARDADO, RECHAZADO]} caseId="c-1" puedeAbrir={false} />);

    // «10.0 MB» es lo que daba `formatBytes` sobre el centinela, y es lo que
    // hacía que el analista pidiera recortar un poquito un archivo de 80 MB.
    expect(screen.queryByText("10.0 MB")).not.toBeInTheDocument();
  });

  it("el guardado sigue mostrando su tamaño", () => {
    render(<AttachmentsPanel attachments={[GUARDADO, RECHAZADO]} caseId="c-1" puedeAbrir={false} />);

    expect(screen.getByText("200.0 KB")).toBeInTheDocument();
    expect(screen.getByText("frente.jpg")).toBeInTheDocument();
  });

  it("un motivo que nadie previó no se pinta crudo", () => {
    render(
      <AttachmentsPanel
        attachments={[{ ...RECHAZADO, rejected_reason: "vaya_a_saber" }]}
        caseId="c-1"
        puedeAbrir={false}
      />
    );

    expect(screen.queryByText(/vaya_a_saber/)).not.toBeInTheDocument();
    expect(screen.getByText(/No se pudo guardar/i)).toBeInTheDocument();
  });

  it("un archivo de WhatsApp que no se pudo bajar avisa que lo reenvíen", () => {
    render(
      <AttachmentsPanel
        attachments={[{ ...RECHAZADO, rejected_reason: "download_failed" }]}
        caseId="c-1"
        puedeAbrir={false}
      />
    );

    expect(screen.getByText(/pedile que lo reenvíe/i)).toBeInTheDocument();
  });

  it("«Abrir» sólo aparece con bytes guardados y un rol que puede verlos", () => {
    const { rerender } = render(
      <AttachmentsPanel attachments={[PROPIO]} caseId="c-1" puedeAbrir={false} />
    );
    expect(screen.queryByText("Abrir")).not.toBeInTheDocument();

    rerender(
      <AttachmentsPanel
        attachments={[{ ...PROPIO, disponible: false }]}
        caseId="c-1"
        puedeAbrir={true}
      />
    );
    expect(screen.queryByText("Abrir")).not.toBeInTheDocument();

    rerender(<AttachmentsPanel attachments={[PROPIO]} caseId="c-1" puedeAbrir={true} />);
    expect(screen.getByText("Abrir")).toBeInTheDocument();
  });

  it("la miniatura sólo aparece para una imagen que se puede abrir", () => {
    const { rerender } = render(
      <AttachmentsPanel attachments={[PROPIO]} caseId="c-1" puedeAbrir={true} />
    );
    expect(screen.getByAltText(PROPIO.filename)).toBeInTheDocument();

    rerender(
      <AttachmentsPanel
        attachments={[{ ...PROPIO, content_type: "application/pdf" }]}
        caseId="c-1"
        puedeAbrir={true}
      />
    );
    expect(screen.queryByAltText(PROPIO.filename)).not.toBeInTheDocument();
  });

  it("muestra qué documento pedido cerró el adjunto", () => {
    render(
      <AttachmentsPanel
        attachments={[{ ...GUARDADO, matched_doc_key: "fotos_danos" }]}
        caseId="c-1"
        puedeAbrir={true}
      />
    );

    expect(screen.getByText("Reconocido como: Fotos de los daños")).toBeInTheDocument();
  });
});
