import type { FillResult, FormSnapshot } from "@ufa/form-engine";
import type { FillItem, VerifyStatus } from "@ufa/form-engine/dom";
import { claimBrowserStep, confirmApplication, createFillTask, reportBrowserStep, sendFillEvent, type BrowserClaim, type MapResult } from "./api";
import { toConfirmItem, type PlannedItem } from "./Fill";
import { analyzeTab, fillTab, verifyTab } from "./page";

/**
 * Fills one approved preview through the task engine (AI browser Phase 2):
 *   read step  → the page inspected for the preview is checkpointed
 *   fill step  → only the approved items are filled, then every one is re-read from the page
 *   report     → completed, or "uncertain" (task paused) when the page changed under us
 * The task then waits for the user's own review; the assistant never clicks Submit or Next.
 */
export interface FillTaskOutcome {
  taskId: string;
  applicationId: string;
  results: FillResult[];
  verification: Record<string, VerifyStatus>;
  pageChanged: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const workerId = () => `panel-${(globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 8)}`;

/** The runner moves a new task to "waiting for the browser" within moments; then the step is ours to claim. */
async function claimFor(taskId: string, stepPrefix: "browser.read_page" | "browser.fill_fields", worker: string): Promise<BrowserClaim> {
  for (let i = 0; i < 40; i++) {
    // Claims this task only: another task of the user is never touched from this page.
    const c = await claimBrowserStep(worker, taskId);
    if (c) {
      if (c.step.step_type !== stepPrefix) {
        await reportBrowserStep(taskId, c.step.id, { leaseToken: c.leaseToken, outcome: "failed", message: `Expected another step here; analyze the page again` }).catch(() => {});
        throw new Error(`The task expected "${c.step.title}" next`);
      }
      return c;
    }
    await sleep(i < 10 ? 250 : 750);
  }
  throw new Error("The task did not become ready. Check the Tasks tab.");
}

export async function fillViaTask(input: {
  tabId: number;
  snapshot: FormSnapshot;
  /** Null when nothing on the page matched the profile (only typed values are filled). */
  mapping: Pick<MapResult, "formSignatureId"> | null;
  items: PlannedItem[];
  /** Continue an existing fill task (multi-page) instead of starting one. */
  taskId?: string | null;
  cafeSessionId?: string | null;
  idempotencyKey: string;
}): Promise<FillTaskOutcome> {
  const worker = workerId();
  const taskId = input.taskId ?? (await createFillTask(input.snapshot.url, input.idempotencyKey)).task.id;

  // 1. Read: the page the user reviewed, checkpointed so a later resume can tell if it changed.
  const read = await claimFor(taskId, "browser.read_page", worker);
  const page = Number(read.step.input_json.page ?? 1);
  await reportBrowserStep(taskId, read.step.id, {
    leaseToken: read.leaseToken,
    outcome: "completed",
    result: { page, fields: input.snapshot.fields.length, approved: input.items.length },
    checkpoint: { page, url: input.snapshot.url, formSignature: input.snapshot.formSignature },
  });

  // 2. Fill: values come from the server (profile) or from what the user typed in the preview.
  const fill = await claimFor(taskId, "browser.fill_fields", worker);
  try {
    // The page must still be the one the user approved.
    const now = await analyzeTab(input.tabId).catch(() => null);
    if (!now?.ok || now.snapshot.formSignature !== input.snapshot.formSignature || now.snapshot.url !== input.snapshot.url) {
      await reportBrowserStep(taskId, fill.step.id, { leaseToken: fill.leaseToken, outcome: "failed", message: "The page changed after you reviewed it. Analyze it again." });
      throw new Error("The page changed after you reviewed it. Analyze the page again and check the preview.");
    }
    const res = await confirmApplication({
      url: input.snapshot.url,
      domain: input.snapshot.domain,
      formTitle: input.snapshot.formTitle,
      pageTitle: input.snapshot.pageTitle,
      formSignatureId: input.mapping?.formSignatureId ?? null,
      items: input.items.map(toConfirmItem),
      cafeSessionId: input.cafeSessionId ?? null,
    });
    const byField = new Map(input.items.map((i) => [i.field.id, i]));
    const fillItems: FillItem[] = res.instructions
      .filter((ins) => byField.has(ins.fieldId))
      .map((ins) => ({ field: byField.get(ins.fieldId)!.field, instruction: { ...ins, overwrite: byField.get(ins.fieldId)!.choice.overwrite } }));
    const filled = await fillTab(input.tabId, fillItems, true);
    if (!filled.ok) {
      // The page went away mid-fill: we cannot know what was typed.
      await reportBrowserStep(taskId, fill.step.id, { leaseToken: fill.leaseToken, outcome: "uncertain", message: "The page was reloaded or closed while filling" });
      throw new Error(filled.error);
    }
    await sendFillEvent(res.applicationId, { type: "FILLED", results: filled.results }).catch(() => {});

    // 3. Verify every field that reported "filled".
    const done = new Set(filled.results.filter((r) => r.status === "filled").map((r) => r.fieldId));
    const verified = await verifyTab(input.tabId, fillItems.filter((i) => done.has(i.field.id)));
    const verification: Record<string, VerifyStatus> = {};
    if (verified.ok) for (const v of verified.results) verification[v.fieldId] = v.status;
    const pageChanged = !verified.ok || Object.values(verification).some((s) => s === "missing" || s === "stale");
    const count = (s: VerifyStatus) => Object.values(verification).filter((x) => x === s).length;
    const summary = {
      page,
      filled: done.size,
      notFilled: filled.results.length - done.size,
      verified: count("verified"),
      mismatched: count("mismatch"),
      gone: count("missing") + count("stale"),
    };
    await reportBrowserStep(taskId, fill.step.id, {
      leaseToken: fill.leaseToken,
      outcome: pageChanged ? "uncertain" : "completed",
      message: pageChanged ? "The page changed while filling; check it before continuing" : `Filled ${summary.filled}, verified ${summary.verified}`,
      result: summary,
      checkpoint: { page, url: input.snapshot.url, formSignature: input.snapshot.formSignature, filled: summary.filled, verified: summary.verified },
    });
    return { taskId, applicationId: res.applicationId, results: filled.results, verification, pageChanged };
  } catch (err) {
    // Anything before the fill started: report a failure so the task does not hang on a lease.
    await reportBrowserStep(taskId, fill.step.id, { leaseToken: fill.leaseToken, outcome: "failed", message: err instanceof Error ? err.message.slice(0, 280) : "Fill failed" }).catch(() => {});
    throw err;
  }
}
