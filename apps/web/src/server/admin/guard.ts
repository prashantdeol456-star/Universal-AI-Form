import "server-only";
import { can, type Permission, type UserRole } from "@ufa/shared";
import type { Actor } from "../db";
import { forbidden } from "../http";

/**
 * Admin services read across tenants with the system pool, so every one of them
 * re-checks the caller's permission itself (defence in depth: routes and pages
 * check too). Admin code must never read values: profile values, filled values,
 * document text or chat — `admin.privacy.test.ts` enforces this on the source.
 */
export function assertAdmin(actor: Actor, permission: Permission) {
  if (!can(actor.role as UserRole, permission)) throw forbidden("Admin access required");
}
