/**
 * Unit tests for authentication Zod schemas and utility functions.
 *
 * Tests the validation logic without requiring a real Neon connection.
 */

import { describe, it, expect } from "vitest";
import { SignInSchema, MeResponseSchema } from "@/lib/schemas/auth";

describe("SignInSchema", () => {
  it("accepts valid email and password", () => {
    const result = SignInSchema.safeParse({
      email: "lucia@seguros-del-sur.com.ar",
      password: "SecurePass123!",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Email is normalized to lowercase.
      expect(result.data.email).toBe("lucia@seguros-del-sur.com.ar");
    }
  });

  it("normalizes email to lowercase", () => {
    const result = SignInSchema.safeParse({
      email: "LUCIA@Seguros-Del-Sur.COM.AR",
      password: "SecurePass123!",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("lucia@seguros-del-sur.com.ar");
    }
  });

  it("rejects invalid email format", () => {
    const result = SignInSchema.safeParse({
      email: "not-an-email",
      password: "SecurePass123!",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing email", () => {
    const result = SignInSchema.safeParse({ password: "SecurePass123!" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = result.error.flatten().fieldErrors;
      expect(errors.email).toBeDefined();
    }
  });

  it("rejects empty password", () => {
    const result = SignInSchema.safeParse({
      email: "lucia@example.com",
      password: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = result.error.flatten().fieldErrors;
      expect(errors.password).toBeDefined();
    }
  });

  it("rejects password exceeding 128 characters", () => {
    const longPassword = "a".repeat(129);
    const result = SignInSchema.safeParse({
      email: "lucia@example.com",
      password: longPassword,
    });
    expect(result.success).toBe(false);
  });

  it("rejects email exceeding 254 characters", () => {
    const longEmail = "a".repeat(250) + "@b.com";
    const result = SignInSchema.safeParse({
      email: longEmail,
      password: "ValidPass123!",
    });
    expect(result.success).toBe(false);
  });

  it("trims email whitespace", () => {
    const result = SignInSchema.safeParse({
      email: "  lucia@example.com  ",
      password: "ValidPass123!",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("lucia@example.com");
    }
  });
});

describe("MeResponseSchema", () => {
  it("accepts a valid user object", () => {
    const result = MeResponseSchema.safeParse({
      id: "00000000-0000-0000-0000-000000000001",
      email: "lucia@example.com",
      full_name: "Lucía Ramallo",
      role: "analyst",
      tenant_id: "10000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("accepts admin role", () => {
    const result = MeResponseSchema.safeParse({
      id: "00000000-0000-0000-0000-000000000001",
      email: "admin@example.com",
      full_name: "Carlos Admin",
      role: "admin",
      tenant_id: "10000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid role", () => {
    const result = MeResponseSchema.safeParse({
      id: "00000000-0000-0000-0000-000000000001",
      email: "user@example.com",
      full_name: "User",
      role: "superadmin",
      tenant_id: "10000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID id", () => {
    const result = MeResponseSchema.safeParse({
      id: "not-a-uuid",
      email: "user@example.com",
      full_name: "User",
      role: "analyst",
      tenant_id: "10000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(false);
  });
});
