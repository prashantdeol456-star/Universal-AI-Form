/**
 * Application tracker statuses (AI browser Phase 4). The user moves an application by hand.
 * Filling a form never changes the status, and any status that says "you applied" needs the
 * user's explicit confirmation that they submitted it themselves.
 */
export const APPLICATION_STATUSES = [
  "interested",
  "shortlisted",
  "preparing",
  "ready_for_review",
  "applied",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "closed",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  interested: "Interested",
  shortlisted: "Shortlisted",
  preparing: "Preparing",
  ready_for_review: "Ready for your review",
  applied: "Applied",
  assessment: "Assessment",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  closed: "Closed",
};

/** Statuses that only make sense after the user submitted the application themselves. */
export const SUBMITTED_STATUSES: ReadonlySet<ApplicationStatus> = new Set(["applied", "assessment", "interview", "offer"]);
const BEFORE_SUBMIT: ReadonlySet<ApplicationStatus> = new Set(["interested", "shortlisted", "preparing", "ready_for_review"]);

export type TransitionCheck = { ok: true } | { ok: false; code: "same_status" | "unknown_status" | "confirm_applied"; message: string };

/**
 * Any manual move is allowed (people correct mistakes), except: going from a not-yet-submitted
 * status to "applied" or later needs `confirmedSubmittedByUser`.
 */
export function checkTransition(from: ApplicationStatus | null, to: string, confirmedSubmittedByUser: boolean): TransitionCheck {
  if (!(APPLICATION_STATUSES as readonly string[]).includes(to)) return { ok: false, code: "unknown_status", message: "Unknown application status" };
  const target = to as ApplicationStatus;
  if (from === target) return { ok: false, code: "same_status", message: "The application already has this status" };
  if (SUBMITTED_STATUSES.has(target) && (from === null || BEFORE_SUBMIT.has(from)) && !confirmedSubmittedByUser) {
    return { ok: false, code: "confirm_applied", message: "Confirm that you submitted this application yourself before marking it as applied" };
  }
  return { ok: true };
}

/** Deadline / follow-up state shown in the tracker (dates are calendar dates, YYYY-MM-DD). */
export function dueState(date: string | null, today: string): "overdue" | "today" | "soon" | "later" | null {
  if (!date) return null;
  if (date < today) return "overdue";
  if (date === today) return "today";
  const days = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  return days <= 3 ? "soon" : "later";
}

/** A listing is stale when it was not seen at its source (or refreshed) for `days`. */
export function isStale(lastSeenAt: string, now: number, days: number): boolean {
  return now - Date.parse(lastSeenAt) > days * 86_400_000;
}
