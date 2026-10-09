import type { Metrics } from "@ufa/ai";
import { Badge, Card, EmptyState } from "@/components/ui";
import { formatDateTime } from "@/lib/labels";
import { registry } from "@/server/admin/models";
import { requirePageUser } from "@/server/auth/session";
import { ReasonAction } from "../AdminClient";

const pct = (x: number | undefined) => (x === undefined ? "—" : `${(x * 100).toFixed(1)}%`);
const STATUS_TONE: Record<string, "gray" | "green" | "amber" | "red" | "blue"> = {
  PRODUCTION: "green", STAGING: "blue", EVALUATING: "amber", TRAINING: "amber", RETIRED: "gray", DISABLED: "gray", FAILED: "red",
  DRAFT: "amber", VALIDATED: "blue", LOCKED: "green", DISCARDED: "gray",
};

function MetricCell({ m, vs }: { m: Metrics | null; vs?: Metrics | null }) {
  if (!m) return <span className="text-xs text-gray-400">not evaluated</span>;
  const better = vs ? m.accuracy - vs.accuracy : null;
  return (
    <div className="text-xs tabular-nums">
      <div>
        acc <b>{pct(m.accuracy)}</b> · wrong <b className={m.wrongRate > 0.02 ? "text-red-700" : ""}>{pct(m.wrongRate)}</b>
      </div>
      <div className="text-gray-500">
        n={m.n} · abstain {pct(m.abstentionRate)} · ECE {m.ece.toFixed(3)}
        {better !== null && <span className={better >= 0 ? "text-emerald-700" : "text-red-700"}> · {better >= 0 ? "+" : ""}{(better * 100).toFixed(1)} vs prod</span>}
      </div>
    </div>
  );
}

export default async function AdminModelsPage() {
  const user = await requirePageUser("admin:models_manage");
  const r = await registry(user);
  const prod = r.models.find((m) => m.status === "PRODUCTION");

  return (
    <>
      <Card title="Models">
        <p className="mb-3 text-sm text-gray-600">
          Promotion uses the same gate as <code className="rounded bg-gray-100 px-1">npm run ml -- promote</code>: evaluated on the same test set as
          production, more accurate, and at most 2 % wrong mappings. Nothing is deployed — after promoting, set <code className="rounded bg-gray-100 px-1">LOCAL_AI_MODEL</code> on
          the server.
        </p>
        {r.models.length === 0 ? (
          <EmptyState title="No models registered">
            Build a dataset, train on a GPU machine and register the result with <code>npm run ml -- register</code> (see docs/ML_TRAINING.md).
          </EmptyState>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead className="text-xs text-gray-500">
                <tr className="border-b border-gray-100">
                  <th className="px-5 py-2 font-medium">Model</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Test results</th>
                  <th className="py-2 pr-5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {r.models.map((m) => (
                  <tr key={m.id} className="align-top">
                    <td className="px-5 py-2.5">
                      <div className="font-medium text-gray-900">{m.name}</div>
                      <div className="text-xs text-gray-500">
                        {m.baseModel} · serves as <code>{m.servingName ?? "—"}</code> · {m.dataset ?? "no dataset"}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge tone={STATUS_TONE[m.status] ?? "gray"}>{m.status}</Badge>
                      {m.promotedAt && <div className="mt-1 text-xs text-gray-500">{formatDateTime(m.promotedAt)}</div>}
                    </td>
                    <td className="py-2.5 pr-4">
                      <MetricCell m={m.metrics} vs={m.productionMetrics} />
                    </td>
                    <td className="py-2.5 pr-5">
                      <div className="flex flex-wrap gap-2">
                        {m.status === "PRODUCTION" ? (
                          <ReasonAction label="Roll back" url="/api/admin/models" method="POST" needsReason={false} danger confirmText="Restore the previous production model?" body={{ action: "rollback" }} />
                        ) : !["DISABLED", "RETIRED", "FAILED"].includes(m.status) ? (
                          <>
                            {m.status !== "STAGING" && <ReasonAction label="Stage" url="/api/admin/models" method="POST" needsReason={false} body={{ action: "stage", name: m.name }} />}
                            <ReasonAction label="Promote" url="/api/admin/models" method="POST" needsReason={false} confirmText={`Promote ${m.name} to production (if it passes the gate)?`} body={{ action: "promote", name: m.name }} />
                            <ReasonAction label="Disable" url="/api/admin/models" method="POST" needsReason={false} danger body={{ action: "disable", name: m.name }} />
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {prod && <p className="mt-3 text-xs text-gray-500">Production: {prod.name} (LOCAL_AI_MODEL={prod.servingName ?? "—"})</p>}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Datasets">
          {r.datasets.length === 0 ? (
            <p className="text-sm text-gray-500">None yet. <code>npm run ml -- dataset</code> builds one from approved / consensus examples.</p>
          ) : (
            <ul className="-my-2 divide-y divide-gray-100">
              {r.datasets.map((d) => (
                <li key={d.id} className="py-2.5 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-900">
                      {d.name} v{d.version}
                    </span>
                    <Badge tone={STATUS_TONE[d.status] ?? "gray"}>{d.status}</Badge>
                  </div>
                  <div className="text-xs text-gray-500">
                    {d.examples} examples · {d.path ?? "—"} · {formatDateTime(d.createdAt)}
                  </div>
                  {d.errors.map((e) => (
                    <div key={e} className="text-xs text-red-700">✗ {e}</div>
                  ))}
                  {d.warnings.slice(0, 3).map((w) => (
                    <div key={w} className="text-xs text-amber-700">⚠ {w}</div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Baselines">
          {r.baselines.length === 0 ? (
            <p className="text-sm text-gray-500">
              Evaluate the rules engine on a dataset for comparison: <code>npm run ml -- evaluate --dataset &lt;dir&gt; --model rules</code>
            </p>
          ) : (
            <ul className="-my-2 divide-y divide-gray-100">
              {r.baselines.map((b, i) => (
                <li key={i} className="py-2.5 text-sm">
                  <div className="font-medium">
                    {b.name} <span className="font-normal text-gray-500">on {b.dataset ?? "?"}</span>
                  </div>
                  <MetricCell m={b.metrics} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
