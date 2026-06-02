/**
 * Unit tests for AppError and error utilities.
 */

import { describe, it, expect } from "vitest";
import { AppError, ErrorCode, ERROR_STATUS, ERROR_MESSAGES } from "@/lib/errors";

describe("AppError", () => {
  it("has the correct code, status, and default message for MISSING_SESSION", () => {
    const err = new AppError("MISSING_SESSION");
    expect(err.code).toBe("MISSING_SESSION");
    expect(err.status).toBe(401);
    expect(err.message).toBe(ERROR_MESSAGES.MISSING_SESSION);
    expect(err.name).toBe("AppError");
  });

  it("accepts a custom message", () => {
    const err = new AppError("NOT_FOUND", "El caso no existe.");
    expect(err.message).toBe("El caso no existe.");
    expect(err.status).toBe(404);
  });

  it("stores details when provided", () => {
    const details = { field: "email", issue: "invalid" };
    const err = new AppError("VALIDATION_FAILED", undefined, details);
    expect(err.details).toEqual(details);
  });

  it("is an instance of Error", () => {
    const err = new AppError("INTERNAL_ERROR");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });
});

describe("ERROR_STATUS", () => {
  it("maps VALIDATION_FAILED to 400", () => {
    expect(ERROR_STATUS.VALIDATION_FAILED).toBe(400);
  });

  it("maps MISSING_SESSION to 401", () => {
    expect(ERROR_STATUS.MISSING_SESSION).toBe(401);
  });

  it("maps INVALID_CREDENTIALS to 401", () => {
    expect(ERROR_STATUS.INVALID_CREDENTIALS).toBe(401);
  });

  it("maps FORBIDDEN_ROLE to 403", () => {
    expect(ERROR_STATUS.FORBIDDEN_ROLE).toBe(403);
  });

  it("maps NOT_FOUND to 404", () => {
    expect(ERROR_STATUS.NOT_FOUND).toBe(404);
  });

  it("maps FSM_INVALID_TRANSITION to 409", () => {
    expect(ERROR_STATUS.FSM_INVALID_TRANSITION).toBe(409);
  });

  it("maps AI_OUTPUT_INVALID to 422", () => {
    expect(ERROR_STATUS.AI_OUTPUT_INVALID).toBe(422);
  });

  it("maps RATE_LIMITED to 429", () => {
    expect(ERROR_STATUS.RATE_LIMITED).toBe(429);
  });

  it("maps AI_BUDGET_EXCEEDED to 429", () => {
    expect(ERROR_STATUS.AI_BUDGET_EXCEEDED).toBe(429);
  });

  it("maps INTERNAL_ERROR to 500", () => {
    expect(ERROR_STATUS.INTERNAL_ERROR).toBe(500);
  });

  it("maps NOT_IMPLEMENTED to 501", () => {
    expect(ERROR_STATUS.NOT_IMPLEMENTED).toBe(501);
  });
});

describe("ErrorCode enum", () => {
  it("contains all expected codes", () => {
    const codes = Object.values(ErrorCode);
    expect(codes).toContain("MISSING_SESSION");
    expect(codes).toContain("INVALID_CREDENTIALS");
    expect(codes).toContain("NOT_FOUND");
    expect(codes).toContain("FORBIDDEN_ROLE");
    expect(codes).toContain("VALIDATION_FAILED");
    expect(codes).toContain("RATE_LIMITED");
    expect(codes).toContain("AI_BUDGET_EXCEEDED");
    expect(codes).toContain("AI_OUTPUT_INVALID");
    expect(codes).toContain("FSM_INVALID_TRANSITION");
    expect(codes).toContain("INTERNAL_ERROR");
    expect(codes).toContain("NOT_IMPLEMENTED");
  });
});
