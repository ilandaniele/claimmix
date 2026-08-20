/**
 * Who may ask the deployment how it is wired.
 *
 * /api/health lists every dependency, whether each one is configured, and
 * which agent behaviours are switched on. None of that is a secret on its own
 * and together it is a map: which cloud storage, which model transport,
 * whether a mailbox is connected, whether the safety switches are off today.
 * There is no reason for it to be readable by anyone who finds the URL.
 *
 * The smoke check verifies on every run that production still refuses
 * anonymous callers. This verifies it before it ships.
 */

const { mockExecute, mockSelect } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { execute: mockExecute, select: mockSelect },
}));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/health/route";

const SECRET = "un-secreto-largo-y-aburrido";

function request(auth?: string, query = ""): NextRequest {
  return new NextRequest(`https://claimmix.vercel.app/api/health${query}`, {
    headers: auth ? { authorization: auth } : {},
  });
}

/** A deployment with everything wired, so each test can break one thing. */
const CONFIGURED: Record<string, string> = {
  CRON_SECRET: SECRET,
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "bucket",
  GEMINI_API_KEY: "gemini",
  GMAIL_TENANT_ID: "10000000-0000-0000-0000-000000000001",
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(CONFIGURED)) process.env[k] = v;

  // A database with every migration applied, so a test that wants one missing
  // has to say so.
  mockExecute.mockResolvedValue({
    rows: [
      { table_name: "missing_docs", column_name: "declined_at" },
      { table_name: "outbound_messages", column_name: "asked_keys" },
      { table_name: "cases", column_name: "extraction_lease_at" },
    ],
  });
  mockSelect.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
  });
});

afterEach(() => {
  for (const k of Object.keys(CONFIGURED)) delete process.env[k];
  delete process.env.AGENT_DELIBERATION;
});

describe("GET /api/health — who gets to see it", () => {
  it("refuses a caller with no credentials", async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
  });

  it("refuses the wrong secret", async () => {
    const res = await GET(request("Bearer otra-cosa-cualquiera"));
    expect(res.status).toBe(401);
  });

  it("refuses a secret that is merely a prefix of the real one", async () => {
    // The comparison is length-checked before it is timing-safe; a prefix
    // getting through would be the classic way to leak the rest a byte at a
    // time.
    const res = await GET(request(`Bearer ${SECRET.slice(0, -1)}`));
    expect(res.status).toBe(401);
  });

  it("refuses everyone when no secret is configured", async () => {
    // Fail closed. An unconfigured deployment must not answer, and must
    // especially not answer everyone.
    delete process.env.CRON_SECRET;
    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(401);
  });

  it("answers the right secret", async () => {
    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBeLessThan(500);

    const body = await res.json();
    expect(Array.isArray(body.checks)).toBe(true);
  });

  it("says nothing about the dependencies in the refusal", async () => {
    // A 401 that leaks the shape of the answer defeats the point of the 401.
    const res = await GET(request());
    const text = JSON.stringify(await res.json());

    expect(text).not.toContain("almacenamiento");
    expect(text).not.toContain("whatsapp");
    expect(text).not.toContain(SECRET);
  });
});

describe("GET /api/health — what it reports", () => {
  it("calls a missing migration down, not merely a warning", async () => {
    // The column is absent, which means a feature is quietly broken in
    // production. That is not something to mention in passing.
    mockExecute.mockResolvedValue({ rows: [{ table_name: "cases", column_name: "id" }] });

    const res = await GET(request(`Bearer ${SECRET}`));
    const body = await res.json();

    const schema = body.checks.find((c: { name: string }) => c.name === "migraciones");
    expect(schema.status).toBe("down");
    expect(schema.detail).toContain("missing_docs.declined_at");
  });

  it("answers 503 when anything is down, so a watcher notices", async () => {
    mockExecute.mockRejectedValue(new Error("connection refused"));

    const res = await GET(request(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("down");
  });

  it("calls missing storage credentials down", async () => {
    // The exact production failure this endpoint was written for: R2 working
    // on a laptop and absent from the deployment, silently, for hours.
    delete process.env.R2_BUCKET;

    const res = await GET(request(`Bearer ${SECRET}`));
    const body = await res.json();
    const storage = body.checks.find((c: { name: string }) => c.name === "almacenamiento");

    expect(storage.status).toBe("down");
    expect(storage.detail).toContain("R2_BUCKET");
  });

  it("flags a deployment running with the agent switched off", async () => {
    // Not a failure — both switches exist on purpose — but a deployment
    // quietly behaving like the old decision tree is worth seeing rather than
    // deducing from the messages.
    process.env.AGENT_DELIBERATION = "off";

    const res = await GET(request(`Bearer ${SECRET}`));
    const body = await res.json();
    const agent = body.checks.find((c: { name: string }) => c.name === "agente");

    expect(agent.status).toBe("degraded");
    expect(agent.detail).toContain("deliberación OFF");

    delete process.env.AGENT_DELIBERATION;
  });

  it("does not touch storage or the model unless asked to go deep", async () => {
    // The shallow check has to stay free, or nobody runs it.
    const res = await GET(request(`Bearer ${SECRET}`));
    const body = await res.json();

    expect(body.deep).toBe(false);
    const storage = body.checks.find((c: { name: string }) => c.name === "almacenamiento");
    expect(storage.detail).toContain("sin probar");
  });
});
