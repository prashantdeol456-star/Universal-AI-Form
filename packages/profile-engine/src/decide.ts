import type { ProfileFieldSource } from "@ufa/shared";

/**
 * Pure decision logic for writing a value into the master profile.
 * Persistence code (apps/web/src/server/profile) executes the returned action;
 * keeping the rules here makes them testable and shared by every entry point
 * (manual edit, document extraction, AI chat, application capture).
 */
export interface ExistingFieldState {
  value: string; // plaintext (already decrypted)
  source: ProfileFieldSource;
  verified: boolean;
  confidence: number | null;
}

export interface IncomingValue {
  value: string; // normalized plaintext
  source: ProfileFieldSource;
  /** The user personally confirmed this value (typed it, clicked Confirm, chose it in a conflict). */
  userConfirmed: boolean;
  /** The user explicitly agreed to replace a different, already verified value. */
  confirmOverwrite?: boolean;
  confidence?: number | null;
}

export type UpdateDecision =
  | { action: "CREATE"; verified: boolean }
  | { action: "UPDATE"; verified: boolean }
  | { action: "VERIFY" }
  | { action: "NOOP"; reason: string }
  | { action: "CONFLICT"; reason: string };

export function normalizeForCompare(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function decideFieldUpdate(existing: ExistingFieldState | null, incoming: IncomingValue): UpdateDecision {
  const incomingVerified = incoming.userConfirmed;

  if (!existing) return { action: "CREATE", verified: incomingVerified };

  const same = normalizeForCompare(existing.value) === normalizeForCompare(incoming.value);
  if (same) {
    if (!existing.verified && incomingVerified) return { action: "VERIFY" };
    return { action: "NOOP", reason: "Value unchanged" };
  }

  if (existing.verified) {
    // Verified data is only ever replaced by an explicit, user-confirmed overwrite.
    if (incomingVerified && incoming.confirmOverwrite) return { action: "UPDATE", verified: true };
    return {
      action: "CONFLICT",
      reason: incomingVerified
        ? "A different verified value exists; explicit overwrite confirmation required"
        : "A verified value exists; unverified data cannot replace it",
    };
  }

  // Existing value is unverified.
  if (incomingVerified) return { action: "UPDATE", verified: true };

  const existingConf = existing.confidence ?? 0;
  const incomingConf = incoming.confidence ?? 0;
  if (incomingConf > existingConf) return { action: "UPDATE", verified: false };
  return { action: "CONFLICT", reason: "Two unverified sources disagree" };
}
