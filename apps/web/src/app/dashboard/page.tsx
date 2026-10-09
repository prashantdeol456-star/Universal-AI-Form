import Link from "next/link";
import type { ReactNode } from "react";
import { getFieldDef } from "@ufa/shared";
import { IconArrowRight, IconCheckCircle, IconCircle, IconFile, IconForm, IconHistory, IconSpark, IconUser } from "@/components/icons";
import { Badge, ButtonLink, Card, EmptyState, ProgressBar, Stat } from "@/components/ui";
import { actionLabel, statusMeta, timeAgo } from "@/lib/labels";
import { requirePageUser } from "@/server/auth/session";
import { getDashboardStats } from "@/server/dashboard";

const pct = (v: number | null) => (v === null ? "—" : `${v}%`);

function greeting() {
  const h = Number(new Date().toLocaleString("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default async function DashboardHome() {
  const user = await requirePageUser();
  const s = await getDashboardStats(user);

  const steps: Array<{ done: boolean; title: string; text: string; href: string; cta: string }> = [
    { done: user.emailVerified, title: "Verify your email", text: "Needed for password recovery and security alerts.", href: "/dashboard/settings", cta: "Verify" },
    { done: s.profileCompletion >= 70, title: "Complete your profile", text: `${s.profileCompletion}% done — forms are filled from it.`, href: "/dashboard/profile", cta: "Add details" },
    { done: s.documents > 0, title: "Upload a document", text: "Aadhaar, marksheet or certificate: values are read for you to confirm.", href: "/dashboard/documents", cta: "Upload" },
    { done: s.totalApplications > 0, title: "Fill your first form", text: "Open a form, click the extension icon, review and confirm.", href: "/dashboard/applications", cta: "How it works" },
  ];
  const doneSteps = steps.filter((x) => x.done).length;

  return (
    <>
      <section className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-brand-600 via-brand-600 to-indigo-700 px-6 py-6 text-white shadow-sm sm:px-8">
        <div className="pointer-events-none absolute -top-16 -right-10 size-56 rounded-full bg-white/10" aria-hidden="true" />
        <div className="pointer-events-none absolute -right-24 -bottom-24 size-72 rounded-full bg-white/5" aria-hidden="true" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm text-white/75">{greeting()},</p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{user.fullName.split(" ")[0]}</h1>
            <p className="mt-1 max-w-xl text-sm text-white/80">
              {s.awaitingSubmit > 0
                ? `${s.awaitingSubmit} filled form${s.awaitingSubmit === 1 ? " is" : "s are"} waiting for you to submit on the website.`
                : "One verified profile for every online form. You review, the assistant fills, you submit."}
            </p>
          </div>
          <div className="flex gap-2">
            <ButtonLink href="/dashboard/profile" variant="inverseOutline">
              My profile
            </ButtonLink>
            <ButtonLink href="/dashboard/history" variant="inverse">
              View history
            </ButtonLink>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={<IconUser size={20} />} label="Profile completion" value={`${s.profileCompletion}%`} hint={`${s.verifiedCompletion}% verified`} />
        <Stat icon={<IconForm size={20} />} tone="green" label="Applications" value={s.totalApplications} hint={`${s.submitted} submitted · ${s.applicationsThisMonth} this month`} />
        <Stat icon={<IconFile size={20} />} tone="amber" label="Documents" value={s.documents} hint={s.openConflicts ? `${s.openConflicts} value conflicts to resolve` : "All values consistent"} />
        <Stat icon={<IconSpark size={20} />} tone="gray" label="AI suggestions accepted" value={pct(s.ai.aiFillSuccessPct)} hint={s.ai.totalRequests ? `${s.ai.totalRequests} AI requests · ${pct(s.ai.geminiUsagePct)} Gemini` : "No AI activity yet"} />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Getting started" actions={<span className="text-xs font-medium text-gray-500">{doneSteps} of {steps.length} done</span>}>
          <ProgressBar value={(doneSteps / steps.length) * 100} tone={doneSteps === steps.length ? "green" : "blue"} label="Setup progress" />
          <ol className="mt-4 space-y-1">
            {steps.map((st) => (
              <li key={st.title} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-gray-50">
                {st.done ? <IconCheckCircle size={22} className="shrink-0 text-emerald-500" /> : <IconCircle size={22} className="shrink-0 text-gray-300" />}
                <div className="min-w-0 flex-1">
                  <div className={`text-sm font-medium ${st.done ? "text-gray-500 line-through decoration-gray-300" : "text-gray-900"}`}>{st.title}</div>
                  <div className="truncate text-xs text-gray-500">{st.text}</div>
                </div>
                {!st.done && (
                  <Link href={st.href} className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700">
                    {st.cta} <IconArrowRight size={14} />
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </Card>

        <Card
          className="lg:col-span-2"
          title="Profile"
          actions={
            <Link href="/dashboard/profile" className="text-xs font-semibold text-brand-600 hover:underline">
              Open
            </Link>
          }
        >
          <div className="flex items-baseline justify-between">
            <span className="text-3xl font-semibold tabular-nums">{s.profileCompletion}%</span>
            <span className="text-xs text-gray-500">{s.verifiedCompletion}% verified</span>
          </div>
          <div className="mt-2">
            <ProgressBar value={s.profileCompletion} label="Profile completion" />
          </div>
          {s.missingCoreFields.length === 0 ? (
            <p className="mt-4 text-sm text-gray-600">All core fields are filled. Nice.</p>
          ) : (
            <>
              <p className="mt-4 text-xs font-medium text-gray-500">Most forms ask for these, still missing:</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {s.missingCoreFields.slice(0, 10).map((k) => (
                  <li key={k}>
                    <Badge>{getFieldDef(k)?.label.en ?? k}</Badge>
                  </li>
                ))}
                {s.missingCoreFields.length > 10 && (
                  <li>
                    <Badge tone="blue">+{s.missingCoreFields.length - 10} more</Badge>
                  </li>
                )}
              </ul>
            </>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Recent applications"
          actions={
            <Link href="/dashboard/history" className="text-xs font-semibold text-brand-600 hover:underline">
              All history
            </Link>
          }
        >
          {s.recentApplications.length === 0 ? (
            <EmptyState icon={<IconForm size={22} />} title="No applications yet">
              Fill a form with the Chrome extension and it will appear here.
            </EmptyState>
          ) : (
            <ul className="-my-2 divide-y divide-gray-100">
              {s.recentApplications.map((a) => (
                <Row key={a.id} href={`/dashboard/applications/${a.id}`} title={a.formName ?? a.domain} sub={`${a.domain} · ${timeAgo(a.createdAt)}`}>
                  <Badge tone={statusMeta(a.status).tone}>{statusMeta(a.status).label}</Badge>
                </Row>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Recent account activity"
          actions={
            <Link href="/dashboard/privacy" className="text-xs font-semibold text-brand-600 hover:underline">
              Access log
            </Link>
          }
        >
          {s.recentActivity.length === 0 ? (
            <EmptyState icon={<IconHistory size={22} />} title="No activity recorded yet" />
          ) : (
            <ul className="-my-1 space-y-0.5">
              {s.recentActivity.map((a, i) => (
                <li key={i} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="size-1.5 shrink-0 rounded-full bg-brand-400" aria-hidden="true" />
                    <span className="truncate text-gray-700">{actionLabel(a.action)}</span>
                  </span>
                  <time className="shrink-0 text-xs text-gray-400" dateTime={a.createdAt}>
                    {timeAgo(a.createdAt)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function Row({ href, title, sub, children }: { href: string; title: string; sub: string; children: ReactNode }) {
  return (
    <li>
      <Link href={href} className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-gray-50">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-gray-900">{title}</span>
          <span className="block truncate text-xs text-gray-500">{sub}</span>
        </span>
        {children}
      </Link>
    </li>
  );
}
