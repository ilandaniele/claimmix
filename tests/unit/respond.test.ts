/**
 * Unit tests for the API response helpers.
 */

import { describe, it, expect } from "vitest";
import { ok, created, accepted, noContent, err } from "@/lib/api/respond";
import { AppError } from "@/lib/errors";

describe("ok()", () => {
  it("returns 200 status with data", async () => {
    const res = ok({ hello: "world" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hello: "world" });
  });

  it("accepts a custom status code", async () => {
    const res = ok({ msg: "accepted" }, 202);
    expect(res.status).toBe(202);
  });
});

describe("created()", () => {
  it("returns 201 status", () => {
    const res = created({ id: "123" });
    expect(res.status).toBe(201);
  });
});

describe("accepted()", () => {
  it("returns 202 status", () => {
    const res = accepted({ case_id: "abc" });
    expect(res.status).toBe(202);
  });
});

describe("noContent()", () => {
  it("returns 204 status with no body", () => {
    const res = noContent();
    expect(res.status).toBe(204);
  });
});

describe("err()", () => {
  it("returns correct status and body from AppError", async () => {
    const error = new AppError("NOT_FOUND");
    const res = err(error);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.message).toBe("string");
  });

  it("includes details when AppError has them", async () => {
    const error = new AppError("VALIDATION_FAILED", "Invalid input", { field: "email" });
    const res = err(error);
    const body = await res.json();
    expect(body.error.details).toEqual({ field: "email" });
  });

  it("handles ErrorCode string directly", async () => {
    const res = err("RATE_LIMITED");
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("handles unknown error with INTERNAL_ERROR 500", async () => {
    const res = err(new TypeError("some internal error"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    // NEVER includes internal error details in response.
    expect(JSON.stringify(body)).not.toContain("some internal error");
  });

  it("handles string that is not an ErrorCode as INTERNAL_ERROR", async () => {
    const res = err("some_random_string");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("handles null/undefined as INTERNAL_ERROR", async () => {
    const res = err(null);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("AppError without details omits the details key", async () => {
    const error = new AppError("NOT_FOUND");
    const res = err(error);
    const body = await res.json();
    expect("details" in body.error).toBe(false);
  });
});
