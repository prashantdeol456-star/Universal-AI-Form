type Tone = "gray" | "green" | "amber" | "red" | "blue";

export const MISSION_LABEL: Record<string, string> = { planned: "Planned (not started)", running: "Running", paused: "Paused", completed: "Completed", failed: "Failed", cancelled: "Cancelled" };
export const MISSION_TONE: Record<string, Tone> = { planned: "gray", running: "blue", paused: "amber", completed: "green", failed: "red", cancelled: "gray" };
export const PART_LABEL: Record<string, string> = { pending: "Waiting", running: "Working", completed: "Done", failed: "Failed", cancelled: "Cancelled", skipped: "Skipped" };
export const PART_TONE: Record<string, Tone> = { pending: "gray", running: "blue", completed: "green", failed: "red", cancelled: "gray", skipped: "gray" };
