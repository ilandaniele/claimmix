import { describe, expect, it } from "vitest";

import {
  buildApprovedExamplesCsvSummary,
  buildApprovedExamplesJsonl,
  canExportAgentData,
  sanitizeExportPayload,
  type ApprovedExampleExportRow,
} from "@/server/agents/export";

describe("agent export permissions", () => {
  it("allows owner/admin full JSON exports", () => {
    expect(
      canExportAgentData("admin", {
        exportType: "full",
        format: "json",
        piiMode: "masked",
      })
    ).toBe(true);
    expect(
      canExportAgentData("owner", {
        exportType: "config_only",
        format: "json",
        piiMode: "full_admin_only",
      })
    ).toBe(true);
  });

  it("allows specialists to export approved examples only", () => {
    expect(
      canExportAgentData("specialist", {
        exportType: "memory_only",
        format: "jsonl_approved_examples",
        piiMode: "masked",
      })
    ).toBe(true);
    expect(
      canExportAgentData("specialist", {
        exportType: "full",
        format: "json",
        piiMode: "masked",
      })
    ).toBe(false);
  });

  it("denies analyst and viewer exports", () => {
    for (const role of ["analyst", "viewer"] as const) {
      expect(
        canExportAgentData(role, {
          exportType: "memory_only",
          format: "jsonl_approved_examples",
          piiMode: "masked",
        })
      ).toBe(false);
    }
  });
});

describe("sanitizeExportPayload", () => {
  it("masks PII and always removes secrets", () => {
    const sanitized = sanitizeExportPayload(
      {
        dni: "12345678",
        policy_number: "POL-123456",
        email: "juan@example.com",
        phone: "+59899123456",
        address: "Av Siempre Viva 742",
        gemini_api_key_encrypted: "secret",
        body: "DNI 12345678, mail juan@example.com, tel +59899123456, poliza POL-123456",
      },
      "masked",
      false
    ) as Record<string, unknown>;

    expect(sanitized.dni).toBe("****5678");
    expect(sanitized.policy_number).toBe("POL-***456");
    expect(sanitized.email).toBe("j***@example.com");
    expect(sanitized.phone).toBe("+598****3456");
    expect(sanitized.address).toBe("[address_masked]");
    expect(sanitized).not.toHaveProperty("gemini_api_key_encrypted");
    expect(String(sanitized.body)).not.toContain("juan@example.com");
    expect(String(sanitized.body)).not.toContain("12345678");
  });

  it("excludes sensitive keyed fields and scrubs free text patterns", () => {
    const sanitized = sanitizeExportPayload(
      {
        dni: "12345678",
        input_payload: {
          body: "DNI 12345678 y email juan@example.com",
        },
      },
      "excluded",
      false
    ) as { input_payload: { body: string }; dni?: string };

    expect(sanitized.dni).toBeUndefined();
    expect(sanitized.input_payload.body).toContain("[dni_excluded]");
    expect(sanitized.input_payload.body).toContain("[email_excluded]");
  });

  it("keeps PII for full_admin_only while still removing secrets", () => {
    const sanitized = sanitizeExportPayload(
      {
        email: "juan@example.com",
        access_token: "token",
      },
      "full_admin_only",
      true
    ) as Record<string, unknown>;

    expect(sanitized.email).toBe("juan@example.com");
    expect(sanitized).not.toHaveProperty("access_token");
  });
});

describe("approved examples exports", () => {
  const examples: ApprovedExampleExportRow[] = [
    {
      id: "example-1",
      tenant_id: "tenant-1",
      agent_run_id: "run-1",
      case_id: "case-1",
      claim_message_id: "message-1",
      claim_type: "choque",
      input_payload: {
        subject: "Choque POL-123456",
        body: "DNI 12345678, email juan@example.com",
      },
      expected_output: {
        extracted_fields: {
          dni: "12345678",
        },
      },
      status: "approved",
      approved_by: "user-1",
      approved_at: "2026-06-19T10:00:00.000Z",
      created_at: "2026-06-19T09:00:00.000Z",
      severity: "medium",
      case_status: "listo",
      trainability_score: "0.910",
    },
    {
      id: "example-2",
      agent_run_id: "run-2",
      case_id: "case-2",
      claim_message_id: null,
      claim_type: null,
      input_payload: {},
      expected_output: {},
      status: "rejected",
      approved_by: null,
      approved_at: null,
      created_at: "2026-06-19T09:30:00.000Z",
    },
  ];

  it("exports approved examples as JSONL with metadata", () => {
    const jsonl = buildApprovedExamplesJsonl("tenant-1", examples, "masked", false);
    const lines = jsonl.split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.metadata).toMatchObject({
      tenant_id: "tenant-1",
      example_id: "example-1",
      approved_by: "user-1",
      claim_type: "choque",
    });
    expect(parsed.input.subject).toBe("Choque POL-***456");
    expect(parsed.expected_output.extracted_fields.dni).toBe("****5678");
  });

  it("exports approved examples as CSV summary", () => {
    const csv = buildApprovedExamplesCsvSummary(examples);
    expect(csv.split("\n")[0]).toBe(
      "example_id,claim_id,claim_type,severity,status,trainability_score,approved_by,approved_at"
    );
    expect(csv).toContain("example-1,case-1,choque,medium,listo,0.910,user-1");
    expect(csv).not.toContain("example-2");
  });
});
