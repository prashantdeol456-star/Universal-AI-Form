"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, SVGProps } from "react";
import {
  IconBookmark, IconChat, IconFile, IconForm, IconHistory, IconHome, IconLock, IconSettings, IconShield, IconSpark, IconStore, IconUser,
} from "./icons";
import { NAV_GROUPS, type NavIcon, type NavItem } from "./nav";

const ICONS: Record<NavIcon, ComponentType<SVGProps<SVGSVGElement> & { size?: number }>> = {
  home: IconHome, user: IconUser, chat: IconChat, file: IconFile, form: IconForm, history: IconHistory,
  bookmark: IconBookmark, spark: IconSpark, shield: IconShield, settings: IconSettings, store: IconStore, lock: IconLock,
};

export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 pb-3 lg:block lg:space-y-5 lg:overflow-visible lg:pb-0">
      {NAV_GROUPS.map((group) => {
        const groupItems = items.filter((i) => i.group === group);
        if (!groupItems.length) return null;
        return (
          <div key={group} className="flex gap-1 lg:block lg:space-y-0.5">
            <div className="hidden px-3 pb-1 text-[11px] font-semibold tracking-wider text-gray-400 uppercase lg:block">{group}</div>
            {groupItems.map((item) => {
              const active = isActive(item.href);
              const Icon = ICONS[item.icon];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`group flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors ${
                    active ? "bg-brand-50 font-semibold text-brand-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                  }`}
                >
                  <Icon size={17} className={active ? "text-brand-600" : "text-gray-400 group-hover:text-gray-600"} />
                  <span className="flex-1">{item.label}</span>
                  {item.plannedPhase && (
                    <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500" title={`Planned for phase ${item.plannedPhase}`}>
                      Soon
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
