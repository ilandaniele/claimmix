/**
 * General-purpose utilities for ClaimMix.
 */

/**
 * Merge class names conditionally (Tailwind-friendly).
 * Lightweight alternative to clsx — avoids an extra dependency for W1.
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * Format a date string or Date object to a human-readable es-AR string.
 * Uses the "America/Argentina/Buenos_Aires" timezone.
 *
 * @example
 * formatDate("2024-01-15T10:30:00Z") // "15/01/2024 07:30"
 */
export function formatDate(
  date: string | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...options,
  });
}

/**
 * Format a duration in seconds to a human-readable string (es-AR).
 * Used for "antigüedad" (age of the case) in the dashboard.
 */
export function formatAge(createdAt: string): string {
  const created = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMinutes < 1) return "Ahora";
  if (diffMinutes < 60) return `Hace ${diffMinutes}m`;
  if (diffHours < 24) return `Hace ${diffHours}h`;
  return `Hace ${diffDays}d`;
}

/**
 * Truncate a string to maxLength characters, appending "..." if truncated.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + "...";
}
