import "server-only";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { CAPABILITIES, checkLocalStep, IMPLEMENTED_CAPABILITIES, LOCAL_STEPS, type Capability, type FolderAccess } from "@ufa/local-agent";
import type { JsonObject } from "@ufa/tasks";
import { PAUSABLE, type TaskStatus } from "@ufa/shared/tasks";
import type { NextRequest } from "next/server";
import { audit } from "../audit";
import { asUser, db, decryptValue, encryptValue, type Actor } from "../db";
import { badRequest, HttpError, notFound } from "../http";
import { tasks } from "../tasks/engine";

/**
 * Local companion pairing and device API (AI browser Phase 6).
 *
 * Pairing works like a TV sign-in: the companion starts a pairing (sending a poll secret it
 * generated) and shows a short code; the signed-in user enters that code in the dashboard and
 * checks the device name; the companion's next poll receives a device token, once. The code
 * expires after 10 minutes and is single-use. Only SHA-256 hashes of the code, poll secret and
 * token are stored. The companion only ever connects out to this server.
 *
 * A device has no capabilities until the user grants them, and gets no work while revoked or
 * while the emergency stop is on. Folders are granted on the computer only; the server keeps a
 * display copy (encrypted) and can revoke but never add.
 */
export const PAIRING_TTL_MS = 10 * 60_000;
export const ONLINE_WINDOW_MS = 90_000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

function newCode(): string {
  let c = "";
  for (let i = 0; i < 8; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

export async function startPairing(input: { name: string; platform: "windows" | "macos" | "linux"; version: string; pollSecret: string }) {
  const code = newCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  const sql = db().system;
  await sql`delete from companion_pairings where expires_at < now() - interval '1 day'`;
  const [row] = await sql<{ id: string }[]>`
    insert into companion_pairings (code_hash, poll_secret_hash, device_name, platform, companion_version, expires_at)
    values (${sha(normalizeCode(code))}, ${sha(input.pollSecret)}, ${input.name}, ${input.platform}, ${input.version}, ${expiresAt}) returning id`;
  return { pairingId: row!.id, code, expiresAt: expiresAt.toISOString() };
}

interface PairingRow {
  id: string;
  device_name: string;
  platform: string;
  companion_version: string;
  expires_at: Date;
  confirmed_user_id: string | null;
  used_at: Date | null;
  created_at: Date;
}

const openPairing = async (code: string) => {
  const [p] = await db().system<PairingRow[]>`
    select * from companion_pairings where code_hash = ${sha(normalizeCode(code))} and expires_at > now() and confirmed_user_id is null`;
  if (!p) throw notFound("No pairing with this code. Codes expire after 10 minutes; start pairing again on your computer.");
  return p;
};

/** What the user is about to pair (shown before they confirm). */
export async function previewPairing(code: string) {
  const p = await openPairing(code);
  return { deviceName: p.device_name, platform: p.platform, version: p.companion_version, startedAt: p.created_at.toISOString(), expiresAt: p.expires_at.toISOString() };
}

export async function confirmPairing(actor: Actor, code: string) {
  const p = await openPairing(code);
  const rows = await db().system`
    update companion_pairings set confirmed_user_id = ${actor.id}, confirmed_at = now()
     where id = ${p.id} and confirmed_user_id is null and expires_at > now() returning id`;
  if (!rows.length) throw notFound("This code was already used or has expired");
  await audit({ actorId: actor.id, actorRole: actor.role, action: "companion.pairing_confirmed", targetType: "companion_pairing", targetId: p.id, metadata: { platform: p.platform } });
  return { deviceName: p.device_name, platform: p.platform };
}

/** The companion polls with its secret; the device token is returned exactly once. */
export async function pollPairing(pairingId: string, pollSecret: string): Promise<{ status: "pending" | "expired" } | { status: "paired"; deviceId: string; token: string }> {
  return db().system.begin(async (tx) => {
    const [p] = await tx<(PairingRow & { poll_secret_hash: string })[]>`select * from companion_pairings where id = ${pairingId} for update`;
    if (!p || p.poll_secret_hash !== sha(pollSecret)) throw notFound("Pairing not found");
    if (p.used_at) throw new HttpError(410, "pairing_used", "This pairing was already completed");
    if (!p.confirmed_user_id) return { status: p.expires_at.getTime() <= Date.now() ? "expired" : "pending" } as const;
    const token = `ufa_dev_${randomBytes(32).toString("base64url")}`;
    const [d] = await tx<{ id: string }[]>`
      insert into companion_devices (user_id, name, platform, companion_version, token_hash)
      values (${p.confirmed_user_id}, ${p.device_name}, ${p.platform}, ${p.companion_version}, ${sha(token)}) returning id`;
    await tx`update companion_pairings set used_at = now(), device_id = ${d!.id} where id = ${p.id}`;
    await audit({ actorId: p.confirmed_user_id, action: "companion.device_paired", targetType: "companion_device", targetId: d!.id, metadata: { platform: p.platform } }, tx);
    return { status: "paired", deviceId: d!.id, token } as const;
  });
}

// ------------------------------------------------------------------ device-token requests

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  platform: string;
  companion_version: string;
  capabilities: Capability[];
  ai_excerpts_allowed: boolean;
  cloud_ai_allowed: boolean;
  status: "active" | "revoked";
  revoked_at: Date | null;
  stop_requested_at: Date | null;
  last_seen_at: Date | null;
  local_ai_status: string | null;
  created_at: Date;
}

export interface DeviceAuth {
  device: DeviceRow;
  actor: Actor;
}

/** Authenticates a companion by its device token (Authorization: Bearer ufa_dev_…). */
export async function requireDevice(req: NextRequest): Promise<DeviceAuth> {
  const auth = req.headers.get("authorization") ?? "";
  const token = /^Bearer (ufa_dev_[A-Za-z0-9_-]{43})$/.exec(auth)?.[1];
  if (!token) throw new HttpError(401, "unauthorized", "Device token required");
  const [row] = await db().system<(DeviceRow & { role: string })[]>`
    select d.*, u.role from companion_devices d join users u on u.id = d.user_id
     where d.token_hash = ${sha(token)} and u.deleted_at is null`;
  if (!row) throw new HttpError(401, "unauthorized", "Unknown device. Pair the companion again.");
  if (row.status !== "active") throw new HttpError(401, "device_revoked", "This device was removed from your account. Pair it again to use it.");
  const { role, ...device } = row;
  return { device, actor: { id: device.user_id, role } };
}

const PROTECTED_LABEL = /^[^\0\r\n]{1,60}$/;

export interface ReportedFolder {
  id: string;
  label: string;
  displayPath: string;
  access: FolderAccess[];
}

/** Heartbeat: the companion reports its folders; it learns stop state, capabilities and folder revocations. */
export async function heartbeat(auth: DeviceAuth, input: { version: string; localAi: "available" | "unavailable" | "unknown"; folders: ReportedFolder[] }) {
  const { device } = auth;
  for (const f of input.folders) if (!PROTECTED_LABEL.test(f.label)) throw badRequest("Invalid folder label");
  return db().system.begin(async (tx) => {
    await tx`update companion_devices set last_seen_at = now(), companion_version = ${input.version}, local_ai_status = ${input.localAi} where id = ${device.id}`;
    const existing = await tx<{ id: string; revoked_at: Date | null }[]>`select id, revoked_at from companion_folders where device_id = ${device.id}`;
    const revoked = new Set(existing.filter((f) => f.revoked_at).map((f) => f.id));
    const reported = new Set(input.folders.map((f) => f.id));
    // Folders removed on the computer disappear here too.
    const gone = existing.filter((f) => !reported.has(f.id)).map((f) => f.id);
    if (gone.length) await tx`delete from companion_folders where device_id = ${device.id} and id = any(${gone}::uuid[])`;
    for (const f of input.folders) {
      if (revoked.has(f.id)) continue;
      await tx`
        insert into companion_folders (id, device_id, user_id, label_encrypted, display_path_encrypted, access)
        values (${f.id}, ${device.id}, ${device.user_id}, ${encryptValue(f.label)}, ${encryptValue(f.displayPath)}, ${f.access}::text[])
        on conflict (device_id, id) do update set label_encrypted = excluded.label_encrypted, display_path_encrypted = excluded.display_path_encrypted,
          access = excluded.access, reported_at = now()`;
    }
    return {
      stop: device.stop_requested_at !== null,
      capabilities: device.capabilities.filter((c) => IMPLEMENTED_CAPABILITIES.includes(c)),
      aiExcerptsAllowed: device.ai_excerpts_allowed,
      revokedFolderIds: [...revoked].filter((id) => reported.has(id)),
      serverTime: new Date().toISOString(),
    };
  });
}

interface FolderRow {
  id: string;
  label_encrypted: string;
  access: FolderAccess[];
  revoked_at: Date | null;
}

const folderFields = ["folderId", "sourceFolderId", "outputFolderId"] as const;

/**
 * Next local step for this device. Only tasks addressed to this device are taken; the server
 * checks the policy too (capability, folder granted and not revoked, stop not pressed), so a
 * step the device may not run fails here instead of reaching the computer.
 */
export async function claimLocalStep(auth: DeviceAuth) {
  const { device, actor } = auth;
  if (device.stop_requested_at) return { claim: null, stopped: true };
  const claim = await tasks().claimExternalStep(actor, `companion:${device.id.slice(0, 8)}`, "local.", null, (t) => (t.input_json as JsonObject).deviceId === device.id);
  if (!claim) return { claim: null, stopped: false };
  const input = claim.task.input_json as JsonObject;
  const spec = (LOCAL_STEPS as Record<string, { access: FolderAccess }>)[claim.step.step_type];
  const field = claim.step.step_type === "local.write_report" ? "outputFolderId" : claim.task.task_type === "local_create_report" ? "sourceFolderId" : "folderId";
  const folderId = typeof input[field] === "string" ? (input[field] as string) : null;
  const [f] = folderId ? await db().system<FolderRow[]>`select id, label_encrypted, access, revoked_at from companion_folders where device_id = ${device.id} and id = ${folderId}` : [];
  const decision = checkLocalStep({
    stepType: claim.step.step_type,
    capabilities: device.capabilities,
    folder: f && !f.revoked_at ? { id: f.id, label: decryptValue(f.label_encrypted), path: "", access: f.access } : null,
    stopped: false,
  });
  if (!decision.allowed || !spec) {
    await tasks().reportStep(actor, claim.task.id, claim.step.id, { leaseToken: claim.leaseToken, outcome: "failed", message: decision.allowed ? "Unknown local action" : decision.reason });
    return { claim: null, stopped: false, refused: decision.allowed ? "Unknown local action" : decision.reason };
  }
  // Every folder of the task must still be granted (e.g. the report's source and output).
  for (const k of folderFields) {
    const id = input[k];
    if (typeof id !== "string") continue;
    const [g] = await db().system<FolderRow[]>`select id, label_encrypted, access, revoked_at from companion_folders where device_id = ${device.id} and id = ${id}`;
    if (!g || g.revoked_at) {
      await tasks().reportStep(actor, claim.task.id, claim.step.id, { leaseToken: claim.leaseToken, outcome: "failed", message: "A folder of this task is no longer approved on the computer" });
      return { claim: null, stopped: false, refused: "folder_not_approved" };
    }
  }
  return {
    stopped: false,
    claim: {
      leaseToken: claim.leaseToken,
      task: { id: claim.task.id, type: claim.task.task_type, input },
      step: { id: claim.step.id, key: claim.step.step_key, type: claim.step.step_type, input: claim.step.input_json },
      previous: claim.previous,
      capabilities: device.capabilities,
      aiExcerptsAllowed: device.ai_excerpts_allowed,
    },
  };
}

/** Report of a claimed local step. Only tasks addressed to this device can be reported on. */
export async function reportLocalStep(auth: DeviceAuth, taskId: string, stepId: string, body: { leaseToken: string; outcome: "progress" | "completed" | "failed" | "uncertain"; message?: string | null; result?: JsonObject | null; secret?: string | null }) {
  const { device, actor } = auth;
  const [t] = await asUser(actor, (tx) => tx<{ input_json: JsonObject }[]>`select input_json from tasks where id = ${taskId}`);
  if (!t || t.input_json.deviceId !== device.id) throw notFound("Task not found");
  return tasks().reportStep(actor, taskId, stepId, { leaseToken: body.leaseToken, outcome: body.outcome, message: body.message ?? null, result: body.result ?? null, secret: body.secret ?? null });
}

// ------------------------------------------------------------------ dashboard (signed-in user)

export interface DeviceView {
  id: string;
  name: string;
  platform: string;
  version: string;
  status: "active" | "revoked";
  online: boolean;
  lastSeenAt: string | null;
  stopped: boolean;
  capabilities: Capability[];
  aiExcerptsAllowed: boolean;
  cloudAiAllowed: boolean;
  localAi: string | null;
  createdAt: string;
  folders: Array<{ id: string; label: string; displayPath: string; access: FolderAccess[]; revoked: boolean }>;
}

export async function listDevices(actor: Actor): Promise<DeviceView[]> {
  return asUser(actor, async (tx) => {
    const devices = await tx<DeviceRow[]>`select * from companion_devices order by status, created_at desc`;
    const folders = await tx<(FolderRow & { device_id: string; display_path_encrypted: string })[]>`select device_id, id, label_encrypted, display_path_encrypted, access, revoked_at from companion_folders`;
    return devices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      version: d.companion_version,
      status: d.status,
      online: d.status === "active" && !!d.last_seen_at && Date.now() - d.last_seen_at.getTime() < ONLINE_WINDOW_MS,
      lastSeenAt: d.last_seen_at?.toISOString() ?? null,
      stopped: d.stop_requested_at !== null,
      capabilities: d.capabilities,
      aiExcerptsAllowed: d.ai_excerpts_allowed,
      cloudAiAllowed: d.cloud_ai_allowed,
      localAi: d.local_ai_status,
      createdAt: d.created_at.toISOString(),
      folders: folders
        .filter((f) => f.device_id === d.id)
        .map((f) => ({ id: f.id, label: decryptValue(f.label_encrypted), displayPath: decryptValue(f.display_path_encrypted), access: f.access, revoked: f.revoked_at !== null })),
    }));
  });
}

async function ownDevice(tx: Parameters<Parameters<typeof asUser>[1]>[0], id: string) {
  const [d] = await tx<DeviceRow[]>`select * from companion_devices where id = ${id} for update`;
  if (!d) throw notFound("Device not found");
  return d;
}

export async function updateDevice(actor: Actor, id: string, patch: { name?: string; capabilities?: Capability[]; aiExcerptsAllowed?: boolean; cloudAiAllowed?: boolean }) {
  if (patch.capabilities?.some((c) => !CAPABILITIES[c]?.implemented)) throw badRequest("That capability is not available yet");
  return asUser(actor, async (tx) => {
    const d = await ownDevice(tx, id);
    if (d.status !== "active") throw badRequest("This device was revoked");
    const ai = patch.aiExcerptsAllowed ?? d.ai_excerpts_allowed;
    const cloud = ai && (patch.cloudAiAllowed ?? d.cloud_ai_allowed);
    const caps = patch.capabilities ? [...new Set(patch.capabilities)] : d.capabilities;
    await tx`update companion_devices set name = ${patch.name ?? d.name}, capabilities = ${caps}::text[], ai_excerpts_allowed = ${ai}, cloud_ai_allowed = ${cloud} where id = ${id}`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "companion.device_updated", targetType: "companion_device", targetId: id, metadata: { capabilities: caps, aiExcerptsAllowed: ai, cloudAiAllowed: cloud } }, tx);
    return { ok: true };
  });
}

/** Active tasks addressed to a device (for stop / revoke). */
async function deviceTaskIds(actor: Actor, deviceId: string, statuses: readonly TaskStatus[]) {
  const rows = await asUser(actor, (tx) => tx<{ id: string }[]>`select id from tasks where input_json->>'deviceId' = ${deviceId} and status = any(${[...statuses]}::text[])`);
  return rows.map((r) => r.id);
}

/**
 * Emergency stop: the device gets no further work, its running step is told to stop at the next
 * heartbeat/progress report, and its active tasks are paused. Nothing resumes on its own: clearing
 * the stop only allows new work; each paused task must be resumed by the user.
 */
export async function stopDevices(actor: Actor, deviceId: string | null) {
  const ids = await asUser(actor, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update companion_devices set stop_requested_at = coalesce(stop_requested_at, now())
       where status = 'active' ${deviceId ? tx`and id = ${deviceId}` : tx``} returning id`;
    if (deviceId && !rows.length) throw notFound("Device not found");
    return rows.map((r) => r.id);
  });
  let paused = 0;
  for (const id of ids) {
    for (const t of await deviceTaskIds(actor, id, PAUSABLE)) {
      try {
        await tasks().pause(actor, t);
        paused++;
      } catch {
        // Finished or changed meanwhile.
      }
    }
  }
  await audit({ actorId: actor.id, actorRole: actor.role, action: "companion.emergency_stop", targetType: "companion_device", targetId: deviceId ?? undefined, metadata: { devices: ids.length, pausedTasks: paused } });
  return { devices: ids.length, pausedTasks: paused };
}

export async function clearStop(actor: Actor, deviceId: string) {
  await asUser(actor, async (tx) => {
    const d = await ownDevice(tx, deviceId);
    if (d.status !== "active") throw badRequest("This device was revoked");
    await tx`update companion_devices set stop_requested_at = null where id = ${deviceId}`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "companion.stop_cleared", targetType: "companion_device", targetId: deviceId }, tx);
  });
  return { ok: true };
}

/** Revoking ends the device token for good and cancels the device's unfinished tasks. */
export async function revokeDevice(actor: Actor, deviceId: string) {
  await asUser(actor, async (tx) => {
    const d = await ownDevice(tx, deviceId);
    if (d.status === "revoked") return;
    await tx`update companion_devices set status = 'revoked', revoked_at = now(), stop_requested_at = coalesce(stop_requested_at, now()), capabilities = '{}'::text[] where id = ${deviceId}`;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "companion.device_revoked", targetType: "companion_device", targetId: deviceId }, tx);
  });
  let cancelled = 0;
  for (const t of await deviceTaskIds(actor, deviceId, ["queued", "running", "waiting_for_browser", "waiting_for_approval", "paused"])) {
    try {
      await tasks().cancel(actor, t);
      cancelled++;
    } catch {
      // Already finished.
    }
  }
  return { ok: true, cancelledTasks: cancelled };
}

export async function revokeFolder(actor: Actor, deviceId: string, folderId: string) {
  return asUser(actor, async (tx) => {
    const rows = await tx`update companion_folders set revoked_at = coalesce(revoked_at, now()) where device_id = ${deviceId} and id = ${folderId} returning id`;
    if (!rows.length) throw notFound("Folder not found");
    await audit({ actorId: actor.id, actorRole: actor.role, action: "companion.folder_revoked", targetType: "companion_device", targetId: deviceId }, tx);
    return { ok: true };
  });
}

/** Device + folders for planning (labels decrypted); only the user's own, active, non-revoked ones. */
export async function planContextFor(actor: Actor, deviceId: string) {
  const all = await listDevices(actor);
  const d = all.find((x) => x.id === deviceId && x.status === "active");
  if (!d) throw notFound("Device not found");
  return { device: d, folders: d.folders.filter((f) => !f.revoked).map((f) => ({ id: f.id, label: f.label, access: f.access })) };
}
