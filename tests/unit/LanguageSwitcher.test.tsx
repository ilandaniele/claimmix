/**
 * Unit tests for LanguageSwitcher component.
 *
 * AC7: Clicking the "EN" button sets the locale cookie to "en-US" and
 * re-renders the nav strings in English.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

// LanguageSwitcher calls useRouter() from next/navigation for router.refresh().
// Mock the module so it doesn't require a Next.js runtime.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("AC7 — LanguageSwitcher cookie write on locale change", () => {
  beforeEach(() => {
    // Reset document.cookie before each test so assertions are clean.
    // jsdom exposes document.cookie as a writable property we can clear.
    Object.defineProperty(document, "cookie", {
      writable: true,
      value: "",
      configurable: true,
    });
  });

  it("renders ES and EN buttons", () => {
    render(
      <LocaleProvider locale="es-AR">
        <LanguageSwitcher />
      </LocaleProvider>,
    );
    expect(screen.getByRole("button", { name: "ES" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "EN" })).toBeInTheDocument();
  });

  it("ES button has aria-pressed=true when locale is es-AR", () => {
    render(
      <LocaleProvider locale="es-AR">
        <LanguageSwitcher />
      </LocaleProvider>,
    );
    expect(screen.getByRole("button", { name: "ES" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "EN" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("clicking EN sets document.cookie with locale=en-US", () => {
    // Spy on the document.cookie setter so we can capture what was written.
    const cookieValues: string[] = [];
    const cookieDescriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "cookie",
    );

    const originalSetter = cookieDescriptor?.set;
    const setSpy = vi.fn((val: string) => {
      cookieValues.push(val);
      // Still call through so jsdom state stays consistent if originalSetter exists.
      if (originalSetter) {
        originalSetter.call(document, val);
      }
    });

    Object.defineProperty(document, "cookie", {
      get: cookieDescriptor?.get,
      set: setSpy,
      configurable: true,
    });

    render(
      <LocaleProvider locale="es-AR">
        <LanguageSwitcher />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "EN" }));

    // The LocaleProvider.setLocale writes:
    // `locale=en-US; path=/; max-age=31536000; SameSite=Lax`
    expect(setSpy).toHaveBeenCalled();
    const written = cookieValues.join(" ");
    expect(written).toContain("locale=en-US");

    // Restore original descriptor.
    if (cookieDescriptor) {
      Object.defineProperty(document, "cookie", cookieDescriptor);
    }
  });

  it("clicking EN flips aria-pressed to true on EN button", () => {
    render(
      <LocaleProvider locale="es-AR">
        <LanguageSwitcher />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "EN" }));

    expect(screen.getByRole("button", { name: "EN" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "ES" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("clicking the already-active locale button does not change aria-pressed state", () => {
    render(
      <LocaleProvider locale="es-AR">
        <LanguageSwitcher />
      </LocaleProvider>,
    );

    // Click the already-active ES button — handleSwitch returns early when next === locale.
    fireEvent.click(screen.getByRole("button", { name: "ES" }));

    expect(screen.getByRole("button", { name: "ES" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
