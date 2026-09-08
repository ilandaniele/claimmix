/**
 * `/api/worker/extract` contesta lo que pasó, no un 200 escrito a mano.
 *
 * La ruta devolvía `{ ok: true }` como constante y el resultado de verdad
 * quedaba anidado en `agent`, que no mira nadie. Quien decide con eso es el
 * redespacho de `worker/extract.ts`:
 *
 *     const llegó = res.ok;
 *     if (llegó) return;              // el mensaje queda por leído
 *
 * Y para cuando corre, la bandera `extraction_pending` ya se limpió. Un 200 que
 * no extrajo nada deja el mensaje guardado y sin leer, sin nada que lo
 * recuerde: alguien manda dos mensajes seguidos y el segundo —donde puede estar
 * el número de póliza que le pedimos— se pierde para siempre.
 *
 * El encabezado de la ruta ya prometía «200 on success, 500 on error». Esto no
 * cambia el contrato: lo empieza a respetar.
 *
 * Las afirmaciones son de comportamiento y no sobre el texto del archivo: acá
 * se puede ejercitar el handler de verdad, porque la ruta sólo importa
 * `runIntakeAgent` y la comprobación del secreto.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const { mockRunIntakeAgent } = vi.hoisted(() => ({ mockRunIntakeAgent: vi.fn() }));

vi.mock("@/server/agents/intake-agent", () => ({ runIntakeAgent: mockRunIntakeAgent }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/worker/extract/route";

const CASO = "11111111-1111-1111-1111-111111111111";
const INQUILINO = "10000000-0000-0000-0000-000000000001";
const SECRETO = "cron-de-prueba";

let secretoOriginal: string | undefined;

beforeEach(() => {
  secretoOriginal = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRETO;
  mockRunIntakeAgent.mockReset();
});

afterEach(() => {
  if (secretoOriginal === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = secretoOriginal;
});

function pedido(): NextRequest {
  return new NextRequest("http://localhost/api/worker/extract", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SECRETO}`,
    },
    body: JSON.stringify({ caseId: CASO, tenantId: INQUILINO }),
  });
}

describe("el worker no da por extraído lo que no extrajo", () => {
  it("un agente que no encontró el caso no contesta 200", async () => {
    mockRunIntakeAgent.mockResolvedValue({
      ok: false,
      caseId: CASO,
      tenantId: INQUILINO,
      action: "case_not_found",
    });

    const res = await POST(pedido());

    expect(res.status).toBe(500);
    expect((await res.json()).agent.action).toBe("case_not_found");
  });

  it("y el redespacho, que decide con res.ok, lo ve como no llegado", async () => {
    // Se afirma sobre lo MISMO que lee `worker/extract.ts`: `res.ok`. Eso ata
    // la prueba al llamador de verdad y no a un número suelto.
    mockRunIntakeAgent.mockResolvedValue({
      ok: false,
      caseId: CASO,
      tenantId: INQUILINO,
      action: "case_not_found",
    });

    const res = await POST(pedido());

    expect(res.ok).toBe(false);
  });

  it("un canal que el agente no reconoce tampoco pasa por bueno", async () => {
    // La trampa futura: el día que alguien agregue un canal y no toque
    // `chooseAction`, todos los redespachos de ese canal darían por leído lo
    // que nunca se leyó.
    mockRunIntakeAgent.mockResolvedValue({
      ok: false,
      caseId: CASO,
      tenantId: INQUILINO,
      channel: "web",
      action: "skip_unsupported_channel",
    });

    expect((await POST(pedido())).status).toBe(500);
  });

  it("y cuando sí extrajo, contesta 200", async () => {
    // El control que impide que el arreglo sea «devolver 500 siempre».
    mockRunIntakeAgent.mockResolvedValue({
      ok: true,
      caseId: CASO,
      tenantId: INQUILINO,
      channel: "email",
      action: "extract_email",
    });

    const res = await POST(pedido());
    const cuerpo = await res.json();

    expect(res.status).toBe(200);
    expect(cuerpo.ok).toBe(true);
  });
});
