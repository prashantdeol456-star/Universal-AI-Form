import Link from "next/link";

const TABS = [
  { href: "/dashboard/jobs", label: "Jobs" },
  { href: "/dashboard/jobs/tracker", label: "Applications" },
  { href: "/dashboard/jobs/sources", label: "Sources & add a job" },
  { href: "/dashboard/jobs/preferences", label: "Preferences" },
  { href: "/dashboard/jobs/feedback", label: "Your feedback & rules" },
] as const;

export function JobsNav({ active }: { active: (typeof TABS)[number]["href"] }) {
  return (
    <nav className="flex flex-wrap gap-1.5" aria-label="Jobs sections">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.href === active ? "page" : undefined}
          className={`rounded-full border px-3 py-1 text-sm ${t.href === active ? "border-brand-600 bg-brand-50 text-brand-700" : "border-gray-200 text-gray-700 hover:bg-gray-50"}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function money(n: number | null, currency: string) {
  if (n === null) return "?";
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${n}`;
  }
}

export function scoreTone(score: number | null): "green" | "blue" | "amber" | "gray" {
  if (score === null) return "gray";
  return score >= 75 ? "green" : score >= 50 ? "blue" : "amber";
}
