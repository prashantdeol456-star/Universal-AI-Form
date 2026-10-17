/**
 * Local companion capabilities (AI browser Phase 6). A paired device starts with NONE. The
 * user grants capabilities per device in the dashboard; folders are granted only on the
 * computer itself (companion CLI), so the server can never widen local access on its own.
 */
export const CAPABILITIES = {
  list_approved_folders: { label: "List files in folders you approved", implemented: true, sideEffects: false },
  read_selected_files: { label: "Read and summarise files in approved folders", implemented: true, sideEffects: false },
  create_file_in_approved_folder: { label: "Create new files (reports) in approved output folders", implemented: true, sideEffects: true },
  move_selected_files: { label: "Rename / move / organise files after you approve a preview (never delete)", implemented: true, sideEffects: true },
  run_approved_command: { label: "Run allowlisted commands (like npm test) in approved project folders", implemented: true, sideEffects: true },
  read_active_window: { label: "See which window is active", implemented: false, sideEffects: false },
  capture_screen_with_approval: { label: "Screenshot after you approve each one", implemented: false, sideEffects: false },
  interact_with_approved_application: { label: "Mouse and keyboard in an approved application", implemented: false, sideEffects: true },
} as const;
export type Capability = keyof typeof CAPABILITIES;

export const IMPLEMENTED_CAPABILITIES = (Object.keys(CAPABILITIES) as Capability[]).filter((c) => CAPABILITIES[c].implemented);

/** What a folder grant (made on the computer) allows. "run" = allowlisted commands may use it as working directory. */
export const FOLDER_ACCESS = ["read", "write", "run"] as const;
export type FolderAccess = (typeof FOLDER_ACCESS)[number];

export interface FolderGrant {
  id: string;
  label: string;
  /** Absolute, resolved path on the computer. Never sent to the server in clear (only a display form). */
  path: string;
  access: FolderAccess[];
}

/** Local step types the companion understands, and the capability each needs. */
export const LOCAL_STEPS = {
  "local.list_files": { capability: "list_approved_folders", access: "read" },
  "local.summarize_files": { capability: "read_selected_files", access: "read" },
  "local.plan_organize": { capability: "move_selected_files", access: "write" },
  "local.apply_changes": { capability: "move_selected_files", access: "write" },
  "local.undo_changes": { capability: "move_selected_files", access: "write" },
  "local.write_report": { capability: "create_file_in_approved_folder", access: "write" },
  "local.run_command": { capability: "run_approved_command", access: "run" },
} as const satisfies Record<string, { capability: Capability; access: FolderAccess }>;
export type LocalStepType = keyof typeof LOCAL_STEPS;

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * The single check before every local action: the device has the capability (from the
 * server), the folder is granted on this computer with the needed access, and the step type
 * is known. A learned workflow or a page/document instruction cannot change any of these.
 */
export function checkLocalStep(input: { stepType: string; capabilities: readonly string[]; folder: FolderGrant | null; stopped: boolean }): PolicyDecision {
  if (input.stopped) return { allowed: false, reason: "Emergency stop is on" };
  const spec = (LOCAL_STEPS as Record<string, { capability: Capability; access: FolderAccess }>)[input.stepType];
  if (!spec) return { allowed: false, reason: `Unknown local action "${input.stepType}"` };
  if (!CAPABILITIES[spec.capability].implemented) return { allowed: false, reason: "This capability is not available yet" };
  if (!input.capabilities.includes(spec.capability)) return { allowed: false, reason: `Not allowed on this device: ${CAPABILITIES[spec.capability].label}` };
  if (!input.folder) return { allowed: false, reason: "The folder is not approved on this computer" };
  if (!input.folder.access.includes(spec.access)) return { allowed: false, reason: `The folder "${input.folder.label}" is not approved for ${spec.access}` };
  return { allowed: true };
}
