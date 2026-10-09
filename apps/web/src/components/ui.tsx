import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "danger" | "ghost" | "inverse" | "inverseOutline";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/60",
  secondary: "bg-white text-gray-800 border border-gray-300 hover:bg-gray-50 disabled:opacity-60",
  danger: "bg-white text-red-700 border border-red-300 hover:bg-red-50 disabled:opacity-60",
  ghost: "text-gray-600 hover:bg-gray-100 disabled:opacity-60",
  // On coloured (brand) backgrounds.
  inverse: "bg-white text-brand-700 hover:bg-brand-50 shadow-sm",
  inverseOutline: "bg-white/10 text-white ring-1 ring-inset ring-white/30 hover:bg-white/20",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-4 py-2 text-sm",
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-xs placeholder:text-gray-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none",
        className,
      )}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none",
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Label({ htmlFor, children, hint }: { htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-gray-700">
      {children}
      {hint && <span className="ml-1 font-normal text-gray-400">{hint}</span>}
    </label>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-2xl border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-gray-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

type Tone = "gray" | "green" | "amber" | "red" | "blue";
const TONES: Record<Tone, string> = {
  gray: "bg-gray-100 text-gray-700",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  blue: "bg-brand-50 text-brand-700 ring-brand-100",
};

export function Badge({ tone = "gray", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-transparent", TONES[tone])}>{children}</span>;
}

export function Alert({ tone = "red", children }: { tone?: "red" | "green" | "amber" | "blue"; children: ReactNode }) {
  const styles = {
    red: "border-red-200 bg-red-50 text-red-800",
    green: "border-emerald-200 bg-emerald-50 text-emerald-800",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    blue: "border-brand-100 bg-brand-50 text-brand-700",
  }[tone];
  return (
    <div role={tone === "red" ? "alert" : "status"} className={cx("rounded-lg border px-3 py-2 text-sm", styles)}>
      {children}
    </div>
  );
}

const ICON_TONES: Record<Tone, string> = {
  gray: "bg-gray-100 text-gray-600",
  green: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  red: "bg-red-50 text-red-600",
  blue: "bg-brand-50 text-brand-600",
};

export function Stat({ label, value, hint, icon, tone = "blue" }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: Tone }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-gray-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
      {icon && <div className={cx("grid size-10 shrink-0 place-items-center rounded-xl", ICON_TONES[tone])}>{icon}</div>}
      <div className="min-w-0">
        <div className="text-xs font-medium text-gray-500">{label}</div>
        <div className="mt-0.5 text-2xl font-semibold text-gray-900 tabular-nums">{value}</div>
        {hint && <div className="mt-0.5 truncate text-xs text-gray-500">{hint}</div>}
      </div>
    </div>
  );
}

/** Title row of a dashboard page: heading, one-line description, optional actions on the right. */
export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs font-medium text-brand-600">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-gray-500">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Friendly placeholder for an empty list, with an optional next step. */
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      {icon && <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-brand-50 text-brand-600">{icon}</div>}
      <div className="text-sm font-semibold text-gray-900">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-gray-500">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ProgressBar({ value, tone = "blue", label }: { value: number; tone?: "blue" | "green" | "amber"; label?: string }) {
  const color = { blue: "bg-brand-500", green: "bg-emerald-500", amber: "bg-amber-500" }[tone];
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="h-2 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx("h-full rounded-full transition-[width]", color)} style={{ width: `${v}%` }} />
    </div>
  );
}

/** Link styled as a button (navigation must stay a real link). */
export function ButtonLink({ href, variant = "primary", size = "md", className, children, external }: { href: string; variant?: Variant; size?: "sm" | "md"; className?: string; children: ReactNode; external?: boolean }) {
  const cls = cx(
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500",
    size === "sm" ? "px-2.5 py-1 text-xs" : "px-4 py-2 text-sm",
    VARIANTS[variant],
    className,
  );
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {children}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}
