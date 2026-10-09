import type { UserRole } from "@ufa/shared";

export type NavIcon = "home" | "user" | "chat" | "file" | "form" | "history" | "bookmark" | "spark" | "shield" | "settings" | "store" | "lock";
export type NavGroup = "Overview" | "Your data" | "Forms" | "Account" | "Workspace";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  group: NavGroup;
  /** Set while the feature is not implemented; the page then explains what is coming. */
  plannedPhase?: number;
  roles?: readonly UserRole[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "home", group: "Overview" },
  { href: "/dashboard/profile", label: "My Profile", icon: "user", group: "Your data" },
  { href: "/dashboard/documents", label: "Documents", icon: "file", group: "Your data" },
  { href: "/dashboard/assistant", label: "AI Assistant", icon: "chat", group: "Your data" },
  { href: "/dashboard/applications", label: "Applications", icon: "form", group: "Forms" },
  { href: "/dashboard/history", label: "History", icon: "history", group: "Forms" },
  { href: "/dashboard/saved-forms", label: "Saved Forms", icon: "bookmark", group: "Forms" },
  { href: "/dashboard/answers", label: "Saved Answers", icon: "chat", group: "Forms" },
  { href: "/dashboard/learning", label: "Learning", icon: "spark", group: "Forms" },
  { href: "/dashboard/cafe-access", label: "Café access", icon: "store", group: "Account" },
  { href: "/dashboard/privacy", label: "Privacy & Access", icon: "shield", group: "Account" },
  { href: "/dashboard/settings", label: "Settings", icon: "settings", group: "Account" },
  { href: "/dashboard/cafe", label: "Café Workspace", icon: "store", group: "Workspace", roles: ["CAFE_OWNER", "CAFE_OPERATOR"] },
  { href: "/dashboard/admin", label: "Admin", icon: "lock", group: "Workspace", roles: ["SUPER_ADMIN"] },
];

export const NAV_GROUPS: readonly NavGroup[] = ["Overview", "Your data", "Forms", "Account", "Workspace"];

export function navFor(role: UserRole): NavItem[] {
  return NAV_ITEMS.filter((i) => !i.roles || i.roles.includes(role));
}
