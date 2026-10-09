import Link from "next/link";
import { IconChart, IconFile, IconForm, IconSpark, IconStore, IconUser } from "@/components/icons";
import { Badge, Card, Stat } from "@/components/ui";
import { formatDateTime, timeAgo } from "@/lib/labels";
import { adminOverview } from "@/server/admin/overview";
import { correctionStats } from "@/server/admin/learning";
import { requirePageUser } from "@/server/auth/session";

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

/** One series per chart (small multiples), single hue, hover title + a screen-reader table. */
function DailyBars({ title, data }: { title: string; data: Array<{ day: string; value: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((n, d) => n + d.value, 0);
  return (
    <figure className="min-w-0">
      <figcaption className="flex items-baseline justify-between text-sm">
        <span className="font-medium text-gray-800">{title}</span>
        <span className="text-xs text-gray-500 tabular-nums">{total} in 30 days</span>
      </figcaption>
      <div className="mt-2 flex h-24 items-end gap-[2px] border-b border-gray-200" aria-hidden="true">
        {data.map((d) => (
          <div key={d.day} className="group relative flex h-full flex-1 items-end" title={`${d.day}: ${d.value}`}>
            <div className="w-full rounded-t-[4px] bg-brand-500 group-hover:bg-brand-700" style={{ height: d.value ? `${Math.max(4, (d.value / max) * 100)}%` : "0" }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-gray-400" aria-hidden="true">
        <span>{data[0]?.day.slice(5)}</span>
        <span>today</span>
      </div>
      <table className="sr-only">
        <caption>{title} per day</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.day}>
              <th scope="row">{d.day}</th>
              <td>{d.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export default async function AdminOverviewPage() {
  const user = await requirePageUser("admin:analytics_view");
  const [o, corrections] = await Promise.all([adminOverview(user), correctionStats(user)]);
  const reviewed = o.ai.suggestionsConfirmed + o.ai.suggestionsCorrected;

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={<IconUser size={20} />} label="Users" value={o.users.total} hint={`${o.users.new30d} new in 30 days · ${o.users.verifiedPct}% verified${o.users.suspended ? ` · ${o.users.suspended} suspended` : ""}`} />
        <Stat icon={<IconStore size={20} />} tone="amber" label="Cafés" value={o.cafes.total} hint={`${o.cafes.active} active · ${o.cafes.activeSessions} sessions running`} />
        <Stat icon={<IconForm size={20} />} tone="green" label="Forms filled (30 days)" value={o.applications.last30d} hint={`${o.applications.submitted30d} submitted · ${o.applications.viaCafe30d} via cafés`} />
        <Stat icon={<IconFile size={20} />} tone="gray" label="Documents" value={o.documents.total} hint={o.documents.failed ? `${o.documents.failed} failed · ${o.documents.queued} queued` : `${o.documents.queued} in the OCR queue`} />
      </div>

      <Card title="Last 30 days">
        <div className="grid gap-6 md:grid-cols-3">
          <DailyBars title="Sign-ups" data={o.perDay.map((d) => ({ day: d.day, value: d.signups }))} />
          <DailyBars title="Forms filled" data={o.perDay.map((d) => ({ day: d.day, value: d.applications }))} />
          <DailyBars title="AI requests" data={o.perDay.map((d) => ({ day: d.day, value: d.aiRequests }))} />
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="AI (30 days)" actions={<IconSpark size={16} className="text-gray-400" />}>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-gray-500">Requests</dt>
              <dd className="text-lg font-semibold tabular-nums">{o.ai.requests30d}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Failures</dt>
              <dd className="text-lg font-semibold tabular-nums">{o.ai.failures30d}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Gemini fields</dt>
              <dd className="text-lg font-semibold tabular-nums">{o.ai.geminiFields30d}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Gemini tokens</dt>
              <dd className="text-lg font-semibold tabular-nums">{o.ai.geminiTokens30d.toLocaleString("en-IN")}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-gray-500">AI suggestions accepted by users</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {pct(o.ai.suggestionsConfirmed, reviewed)} <span className="text-xs font-normal text-gray-500">of {reviewed} reviewed</span>
              </dd>
            </div>
          </dl>
          <div className="mt-3 flex flex-wrap gap-1">
            {Object.entries(o.ai.byProvider).map(([p, n]) => (
              <Badge key={p}>
                {p}: {n}
              </Badge>
            ))}
          </div>
        </Card>

        <Card title="Learning" actions={<Link href="/dashboard/admin/learning" className="text-xs font-semibold text-brand-600 hover:underline">Review</Link>}>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-gray-500">Waiting for review</dt>
              <dd className="text-lg font-semibold tabular-nums">{o.learning.pending}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Approved</dt>
              <dd className="text-lg font-semibold tabular-nums">{o.learning.approved}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Website patterns</dt>
              <dd className="text-lg font-semibold tabular-nums">{o.learning.websitePatterns}</dd>
            </div>
            <div>
              <dt className="text-gray-500">General patterns</dt>
              <dd className="text-lg font-semibold tabular-nums">{o.learning.globalPatterns}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-gray-500">Last learning run: {o.learning.lastRunAt ? timeAgo(o.learning.lastRunAt) : "never"}</p>
        </Card>

        <Card title="Model" actions={<Link href="/dashboard/admin/models" className="text-xs font-semibold text-brand-600 hover:underline">Registry</Link>}>
          {o.models.production ? (
            <div className="space-y-1 text-sm">
              <div className="font-semibold text-gray-900">{o.models.production.name}</div>
              <div className="text-gray-600">
                Served as <code className="rounded bg-gray-100 px-1">{o.models.production.servingName ?? "—"}</code>
              </div>
              <div className="text-xs text-gray-500">promoted {formatDateTime(o.models.production.promotedAt)}</div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No model in production — mapping runs on rules, knowledge and the configured local/Gemini models.</p>
          )}
          <p className="mt-3 text-xs text-gray-500">{o.models.datasets} dataset(s) built.</p>
        </Card>
      </div>

      <Card title="Most corrected mappings" actions={<IconChart size={16} className="text-gray-400" />}>
        {corrections.length === 0 ? (
          <p className="text-sm text-gray-500">No corrections yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="py-1 font-medium">Suggested</th>
                <th className="py-1 font-medium">User chose</th>
                <th className="py-1 font-medium">By</th>
                <th className="py-1 text-right font-medium">Times</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {corrections.map((c, i) => (
                <tr key={i}>
                  <td className="py-1.5 font-mono text-xs">{c.original_mapping ?? "—"}</td>
                  <td className="py-1.5 font-mono text-xs">{c.correct_mapping}</td>
                  <td className="py-1.5 text-xs text-gray-500">{c.original_provider ?? "rules"}</td>
                  <td className="py-1.5 text-right tabular-nums">{c.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
