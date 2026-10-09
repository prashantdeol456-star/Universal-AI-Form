/** Masks a sensitive value for display, keeping only the last 4 characters. */
export function maskValue(value: string, visible = 4): string {
  const compact = value.replace(/\s/g, "");
  if (compact.length <= visible) return "•".repeat(compact.length);
  return "•".repeat(Math.min(compact.length - visible, 8)) + compact.slice(-visible);
}
