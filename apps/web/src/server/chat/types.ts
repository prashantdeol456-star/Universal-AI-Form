// View types shared by the chat service, API routes and client components (no server-only imports).

export type ProposalKind = "NEW" | "UPDATE" | "SAME";
export type ProposalStatus = "PENDING" | "SAVED" | "REJECTED" | "SUPERSEDED" | "INFO";

export interface ChatProposalView {
  id: string;
  fieldKey: string;
  label: string;
  labelHi: string | null;
  /** Masked for sensitive fields (Aadhaar, PAN, bank…). */
  value: string;
  previousValue: string | null;
  kind: ProposalKind;
  status: ProposalStatus;
  method: "rules" | "local_ai";
  confidence: number | null;
}

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  proposals: ChatProposalView[];
}

export interface ChatSessionSummary {
  id: string;
  title: string | null;
  updatedAt: string;
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: ChatMessageView[];
}

export interface SendMessageResult {
  sessionId: string;
  messages: ChatMessageView[];
}
