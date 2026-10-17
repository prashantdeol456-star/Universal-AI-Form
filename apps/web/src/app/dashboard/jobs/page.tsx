import Link from "next/link";
import { APPLICATION_STATUS_LABELS } from "@ufa/jobs";
import { Badge, ButtonLink, Card, EmptyState, PageHeader } from "@/components/ui";
import { requirePageUser } from "@/server/auth/session";
import { searchSchema } from "@/server/jobs/schemas";
import { searchJobs } from "@/server/jobs/service";
import { JobsNav, money, scoreTone } from "./JobsNav";
import { RematchButton } from "./RematchButton";
import { SaveButton } from "./SaveButton";

const input = "w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm";

export default async function JobsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePageUser();
  const raw = Object.fromEntries(Object.entries(await searchParams).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = searchSchema.safeParse(raw);
  const filters = parsed.success ? parsed.data : {};
  const result = await searchJobs(user, filters);
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const pageHref = (p: number) => `/dashboard/jobs?${new URLSearchParams({ ...(raw as Record<string, string>), page: String(p) }).toString()}`;

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Jobs from boards you follow and links you add, ranked by how well your confirmed profile and documents fit them. The score explains itself; it is not a chance of being hired. Nothing is ever applied for you."
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <JobsNav active="/dashboard/jobs" />
        <RematchButton />
      </div>
      {!parsed.success && <p className="text-sm text-red-700">Some filters were not valid and were ignored.</p>}

      <Card>
        <form className="grid gap-2 sm:grid-cols-4" method="get">
          <input name="q" defaultValue={raw.q} placeholder="Keywords" className={input} aria-label="Keywords" maxLength={120} />
          <input name="title" defaultValue={raw.title} placeholder="Job title" className={input} aria-label="Job title" maxLength={120} />
          <input name="employer" defaultValue={raw.employer} placeholder="Employer" className={input} aria-label="Employer" maxLength={120} />
          <input name="location" defaultValue={raw.location} placeholder="Location" className={input} aria-label="Location" maxLength={120} />
          <select name="arrangement" defaultValue={raw.arrangement ?? ""} className={input} aria-label="Work arrangement">
            <option value="">Remote / hybrid / on-site</option>
            <option value="remote">Remote</option>
            <option value="hybrid">Hybrid</option>
            <option value="onsite">On-site</option>
          </select>
          <input name="employmentType" defaultValue={raw.employmentType} placeholder="Employment type (e.g. Full-time)" className={input} aria-label="Employment type" maxLength={60} />
          <input name="maxExperience" type="number" min={0} max={60} defaultValue={raw.maxExperience} placeholder="Asks at most N years" className={input} aria-label="Maximum years of experience asked" />
          <input name="since" type="date" defaultValue={raw.since} className={input} aria-label="Found since" />
          <select name="saved" defaultValue={raw.saved ?? ""} className={input} aria-label="Saved">
            <option value="">Saved and unsaved</option>
            <option value="saved">Saved only</option>
            <option value="unsaved">Not saved</option>
            <option value="shortlisted">Shortlisted only</option>
          </select>
          <div className="flex gap-1">
            <input name="minScore" type="number" min={0} max={100} defaultValue={raw.minScore} placeholder="Score from" className={input} aria-label="Minimum score" />
            <input name="maxScore" type="number" min={0} max={100} defaultValue={raw.maxScore} placeholder="to" className={input} aria-label="Maximum score" />
          </div>
          <select name="sort" defaultValue={raw.sort ?? "score"} className={input} aria-label="Sort">
            <option value="score">Best fit first</option>
            <option value="recent">Newest first</option>
          </select>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" name="includeClosed" value="true" defaultChecked={raw.includeClosed === "true"} /> Include closed jobs
          </label>
          <div className="flex gap-2 sm:col-span-4">
            <button type="submit" className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
              Search
            </button>
            <Link href="/dashboard/jobs" className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
              Clear
            </Link>
          </div>
        </form>
      </Card>

      {result.failedSources.length > 0 && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Partial results: {result.failedSources.map((f) => `${f.name} (${f.status === "rate_limited" ? "asked us to slow down" : f.status === "not_found" ? "board not found" : "could not be read"})`).join(", ")}.
          Jobs from these boards may be missing or out of date. <Link href="/dashboard/jobs/sources" className="underline">Check sources</Link>
        </p>
      )}
      {result.total === 0 ? (
        <EmptyState
          title={Object.keys(raw).length ? "No jobs match these filters" : "No jobs yet"}
          action={<ButtonLink href="/dashboard/jobs/sources">Follow a job board or add a job</ButtonLink>}
        >
          Follow a company&apos;s public Greenhouse or Lever job board, or add a job link yourself.
        </EmptyState>
      ) : (
        <Card title={`${result.total} job${result.total === 1 ? "" : "s"}`}>
          <ul className="divide-y divide-gray-100">
            {result.jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={scoreTone(j.score)}>{j.score === null ? "No score" : `${j.score}/100${j.provisional ? " · provisional" : ""}`}</Badge>
                    <Link href={`/dashboard/jobs/${j.id}`} className="font-medium text-gray-900 hover:text-brand-700 hover:underline">
                      {j.title}
                    </Link>
                    {j.status === "closed" && <Badge tone="red">Closed at source</Badge>}
                    {j.stale && j.status !== "closed" && <Badge tone="amber">Not re-checked recently</Badge>}
                    {j.applicationStatus && <Badge tone="blue">{APPLICATION_STATUS_LABELS[j.applicationStatus]}</Badge>}
                    {j.rankAdjustment !== 0 && <Badge tone="gray">{j.rankAdjustment > 0 ? "+" : ""}{j.rankAdjustment} from your ranking rules</Badge>}
                    {j.shortlisted && <Badge tone="green">Shortlisted</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-gray-500">
                    {j.employer ?? "Employer not given"} · {j.location ?? "Location not given"}
                    {j.workArrangement ? ` · ${j.workArrangement}` : ""}
                    {j.employmentType ? ` · ${j.employmentType}` : ""}
                    {j.experienceMinYears !== null ? ` · asks ${j.experienceMinYears}+ yrs` : ""}
                    {j.salary ? ` · ${money(j.salary.min, j.salary.currency)}–${money(j.salary.max, j.salary.currency)}${j.salary.period ? ` ${j.salary.period}` : ""}` : ""}
                  </div>
                  <div className="text-xs text-gray-400">
                    Source: {j.sourceLabel} · found {new Date(j.retrievedAt).toLocaleDateString("en-IN")}
                    {j.publishedAt ? ` · published ${new Date(j.publishedAt).toLocaleDateString("en-IN")}` : ""}
                  </div>
                </div>
                <SaveButton jobId={j.id} saved={j.saved} />
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <nav className="mt-3 flex items-center gap-2 text-sm" aria-label="Pages">
              {result.page > 1 && <Link href={pageHref(result.page - 1)} className="text-brand-700 hover:underline">← Previous</Link>}
              <span className="text-gray-500">
                Page {result.page} of {pages}
              </span>
              {result.page < pages && <Link href={pageHref(result.page + 1)} className="text-brand-700 hover:underline">Next →</Link>}
            </nav>
          )}
        </Card>
      )}
    </>
  );
}
