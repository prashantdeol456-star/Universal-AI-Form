/**
 * Role-based access control. This matrix drives UI visibility and API guards;
 * the database enforces the same boundaries independently through RLS.
 */
export const USER_ROLES = [
  "SUPER_ADMIN",
  "CAFE_OWNER",
  "CAFE_OPERATOR",
  "CUSTOMER",
  "ENTERPRISE_ADMIN",
  "ENTERPRISE_USER",
] as const;

export type UserRole = (typeof USER_ROLES)[number];

/** Roles that can be chosen at public signup. Others are provisioned. */
export const SELF_SIGNUP_ROLES = ["CUSTOMER", "CAFE_OWNER"] as const satisfies readonly UserRole[];

export const PERMISSIONS = [
  "profile:read_own",
  "profile:write_own",
  "documents:manage_own",
  "applications:manage_own",
  "chat:use",
  "privacy:manage_own",
  "cafe:manage",
  "cafe:operators_manage",
  "cafe:customers_manage",
  "cafe:sessions_request",
  "cafe:reports_view",
  "admin:users_view",
  "admin:learning_manage",
  "admin:models_manage",
  "admin:audit_view",
  "admin:analytics_view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const CUSTOMER_PERMS: Permission[] = [
  "profile:read_own",
  "profile:write_own",
  "documents:manage_own",
  "applications:manage_own",
  "chat:use",
  "privacy:manage_own",
];

export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  SUPER_ADMIN: [
    ...CUSTOMER_PERMS,
    "admin:users_view",
    "admin:learning_manage",
    "admin:models_manage",
    "admin:audit_view",
    "admin:analytics_view",
  ],
  CAFE_OWNER: [
    ...CUSTOMER_PERMS,
    "cafe:manage",
    "cafe:operators_manage",
    "cafe:customers_manage",
    "cafe:sessions_request",
    "cafe:reports_view",
  ],
  CAFE_OPERATOR: [...CUSTOMER_PERMS, "cafe:customers_manage", "cafe:sessions_request"],
  CUSTOMER: CUSTOMER_PERMS,
  ENTERPRISE_ADMIN: CUSTOMER_PERMS,
  ENTERPRISE_USER: CUSTOMER_PERMS,
};

export function can(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}
