/**
 * Unit tests for StatusBadge component.
 *
 * Tests:
 *   - Renders correct label for each status value
 *   - Applies correct CSS color class for each status
 *   - Sets data-status attribute for e2e targeting
 */

import { render, screen } from "@testing-library/react";
import { StatusBadge } from "../../src/app/(app)/bandeja/components/StatusBadge";
import type { CaseStatus } from "../../src/lib/schemas/cases";

const STATUS_CASES: { status: CaseStatus; expectedLabel: string; expectedClass: string }[] =
  [
    { status: "listo", expectedLabel: "Listo", expectedClass: "bg-green-100" },
    { status: "esperando", expectedLabel: "Esperando", expectedClass: "bg-yellow-100" },
    { status: "escalado", expectedLabel: "Escalado", expectedClass: "bg-red-100" },
    { status: "cerrado", expectedLabel: "Cerrado", expectedClass: "bg-slate-100" },
    { status: "procesando", expectedLabel: "Procesando", expectedClass: "bg-blue-100" },
  ];

describe("StatusBadge", () => {
  for (const { status, expectedLabel, expectedClass } of STATUS_CASES) {
    it(`renders "${expectedLabel}" label for status="${status}"`, () => {
      render(<StatusBadge status={status} />);
      expect(screen.getByText(expectedLabel)).toBeInTheDocument();
    });

    it(`applies ${expectedClass} class for status="${status}"`, () => {
      const { container } = render(<StatusBadge status={status} />);
      const badge = container.firstElementChild as HTMLElement;
      expect(badge.className).toContain(expectedClass);
    });

    it(`sets data-status="${status}" attribute`, () => {
      const { container } = render(<StatusBadge status={status} />);
      const badge = container.firstElementChild as HTMLElement;
      expect(badge.getAttribute("data-status")).toBe(status);
    });
  }
});
