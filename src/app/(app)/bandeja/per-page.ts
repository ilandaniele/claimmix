// No "use client": a value exported from a client module reaches server
// components as a reference, not an array.
export const PER_PAGE_OPTIONS = [10, 20, 50, 100] as const;
