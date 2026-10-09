import { IconCheckCircle, IconSearch } from "@/components/icons";
import { Badge, Button, Card, EmptyState, Input, Select } from "@/components/ui";
import { reviewQueue, sharedPatterns } from "@/server/admin/learning";
import { requirePageUser } from "@/server/auth/session";
import { ReasonAction } from "../AdminClient";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function AdminLearningPage({ searchParams }: Props) {
  const user = await requirePageUser("admin:learning_manage");
  const sp = await searchParams;
  const q = one(sp.q);
  const min = Number(one(sp.min)) || 1;
  const scope = one(sp.scope) === "GLOBAL" || one(sp.scope) === "WEBSITE" ? (one(sp.scope) as "GLOBAL" | "WEBSITE") : undefined;
  const [queue, patterns] = await Promise.all([reviewQueue(user, { q, minContributors: min }), sharedPatterns(user, { q, scope })]);

  return (
    <>
      <Card>
        <form method="get" className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto]">
          <div className="relative">
            <IconSearch size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-gray-400" />
            <Input name="q" defaultValue={q} placeholder="Label or profile field" aria-label="Search" className="pl-9" />
          </div>
          <Select name="min" defaultValue={String(min)} aria-label="Minimum contributors">
            <option value="1">Any number of people</option>
            <option value="2">Confirmed by 2+ people</option>
            <option value="3">Confirmed by 3+ people</option>
          </Select>
          <Select name="scope" defaultValue={scope ?? ""} aria-label="Shared pattern scope">
            <option value="">All shared patterns</option>
            <option value="GLOBAL">General patterns</option>
            <option value="WEBSITE">Website patterns</option>
          </Select>
          <Button type="submit">Filter</Button>
        </form>
      </Card>

      <Card title="Examples waiting for review" actions={<Badge tone="amber">{queue.totalPending} pending</Badge>}>
        <p className="mb-3 text-sm text-gray-600">
          Approved examples may be used for training. Each row is one label → profile field, merged across users (shown as counts, never
          names). Rejecting needs a short reason.
        </p>
        {queue.groups.length === 0 ? (
          <EmptyState icon={<IconCheckCircle size={22} />} title="Nothing to review" />
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="text-xs text-gray-500">
                <tr className="border-b border-gray-100">
                  <th className="px-5 py-2 font-medium">Label on websites</th>
                  <th className="py-2 pr-4 font-medium">Maps to</th>
                  <th className="py-2 pr-4 text-right font-medium">People</th>
                  <th className="py-2 pr-4 text-right font-medium">Sites</th>
                  <th className="py-2 pr-5 font-medium">Decision</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {queue.groups.map((g) => (
                  <tr key={`${g.normalizedLabel}|${g.key}`} className="align-top">
                    <td className="px-5 py-2.5">
                      <div className="font-medium text-gray-900">{g.sampleLabel}</div>
                      <div className="text-xs text-gray-500">
                        {g.sections.length ? `in ${g.sections.slice(0, 2).join(", ")} · ` : ""}
                        {g.languages.join("/")} · {g.sources.map((s) => s.toLowerCase().replace(/_/g, " ")).join(", ")}
                      </div>
                      {g.conflicts.length > 0 && (
                        <div className="mt-1 text-xs text-amber-700">
                          Others said: {g.conflicts.map((c) => `${c.key} (${c.contributors})`).join(", ")}
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      <div>{g.keyLabel}</div>
                      <div className="font-mono text-[11px] text-gray-400">{g.key}</div>
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{g.contributors}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{g.domains}</td>
                    <td className="py-2.5 pr-5">
                      <div className="flex flex-wrap gap-2">
                        <ReasonAction
                          label="Approve"
                          url="/api/admin/learning/review"
                          method="POST"
                          needsReason={false}
                          confirmText={`Approve ${g.examples} example(s): "${g.sampleLabel}" → ${g.keyLabel}?`}
                          body={{ normalizedLabel: g.normalizedLabel, key: g.key, decision: "APPROVED" }}
                        />
                        <ReasonAction
                          label="Reject"
                          url="/api/admin/learning/review"
                          method="POST"
                          reasonField="note"
                          danger
                          body={{ normalizedLabel: g.normalizedLabel, key: g.key, decision: "REJECTED" }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Shared knowledge (learned from several users)">
        {patterns.length === 0 ? (
          <p className="text-sm text-gray-500">No shared patterns yet — they appear when at least 2 people agree on a website field, or 3 people on 2 websites.</p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="text-xs text-gray-500">
                <tr className="border-b border-gray-100">
                  <th className="px-5 py-2 font-medium">Label</th>
                  <th className="py-2 pr-4 font-medium">Maps to</th>
                  <th className="py-2 pr-4 font-medium">Scope</th>
                  <th className="py-2 pr-4 text-right font-medium">For / against</th>
                  <th className="py-2 pr-5 font-medium">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {patterns.map((p) => (
                  <tr key={p.id} className="align-top">
                    <td className="px-5 py-2.5 font-medium text-gray-900">{p.label}</td>
                    <td className="py-2.5 pr-4">{p.keyLabel}</td>
                    <td className="py-2.5 pr-4 text-xs text-gray-600">{p.scope === "GLOBAL" ? "everywhere" : p.domain}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">
                      {p.support} / {p.against}
                    </td>
                    <td className="py-2.5 pr-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={p.verified ? "green" : "gray"}>{p.verified ? (p.source === "admin" ? "admin-verified" : "active") : p.source === "admin_disabled" ? "disabled by admin" : "inactive"}</Badge>
                        {p.verified ? (
                          <ReasonAction label="Disable" url={`/api/admin/learning/patterns/${p.id}`} body={{ action: "disable" }} danger />
                        ) : (
                          <ReasonAction label="Verify" url={`/api/admin/learning/patterns/${p.id}`} body={{ action: "verify" }} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
