/**
 * El bucket de adjuntos: lo que se afirma es lo que le llega al cliente S3.
 * El SDK es un doble; no se toca la red.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = m.send;
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
  GetObjectCommand: class {},
  DeleteObjectCommand: class {},
}));

import { uploadAttachment } from "@/server/storage/claim-attachments-bucket";

const OPTS = {
  tenantId: "t1",
  caseId: "c1",
  messageId: "m1",
  filename: "foto.jpg",
  contentType: "image/jpeg",
  data: Buffer.from("x"),
};

describe("uploadAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.R2_ACCOUNT_ID = "cuenta";
    process.env.R2_ACCESS_KEY_ID = "test-access-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
  });

  it("le pasa la señal de aborto al send del cliente", async () => {
    m.send.mockResolvedValue({});
    const controller = new AbortController();

    const res = await uploadAttachment({ ...OPTS, abortSignal: controller.signal });

    expect("storagePath" in res && res.storagePath).toMatch(/^t1\/c1\/m1\/[0-9a-f]{16}-foto\.jpg$/);
    expect(m.send).toHaveBeenCalledOnce();
    expect(m.send.mock.calls[0][1]).toEqual({ abortSignal: controller.signal });
  });

  it("sin señal sigue andando", async () => {
    m.send.mockResolvedValue({});

    const res = await uploadAttachment(OPTS);

    expect("storagePath" in res).toBe(true);
    expect(m.send.mock.calls[0][1]).toEqual({ abortSignal: undefined });
  });

  it("si el cliente corta por la señal, devuelve STORAGE_UPLOAD_FAILED", async () => {
    m.send.mockRejectedValue(Object.assign(new Error("abortada"), { name: "AbortError" }));

    const res = await uploadAttachment({ ...OPTS, abortSignal: AbortSignal.abort() });

    expect(res).toEqual({ error: "STORAGE_UPLOAD_FAILED" });
  });
});
