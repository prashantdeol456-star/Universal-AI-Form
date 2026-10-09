import Link from "next/link";

/** Product mark + name. */
export function Logo({ href = "/dashboard" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2.5" aria-label="Universal AI Form Assistant — home">
      <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-indigo-600 text-white shadow-sm">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <path d="M9 8h6M9 12h6M9 16h3" />
        </svg>
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold text-gray-900">Universal AI Form</span>
        <span className="block text-[11px] text-gray-500">Assistant</span>
      </span>
    </Link>
  );
}
