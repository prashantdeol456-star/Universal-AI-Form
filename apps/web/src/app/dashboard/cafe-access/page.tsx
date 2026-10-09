import { CAFE_PERMISSION_LABELS, type CafePermission } from "@ufa/shared";
import { IconHistory, IconShield, IconStore } from "@/components/icons";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { actionLabel, formatDateTime, timeAgo } from "@/lib/labels";
import { requirePageUser } from "@/server/auth/session";
import { myCafeAccess, type CafeSessionView } from "@/server/cafe/customer";
import { ApproveRequest, CodeGenerator, RevokeSession } from "./CafeAccessClient";

const Perms = ({ list }: { list: CafePermission[] }) => (
  <div className="flex flex-wrap gap-1">
    {list.map((p) => (
      <Badge key={p} tone={p === "identity" || p === "documents" ? "amber" : "blue"}>
        {CAFE_PERMISSION_LABELS[p].en}
      </Badge>
    ))}
  </div>
);

const STATUS: Record<string, { label: string; tone: "gray" | "green" | "amber" | "red" | "blue" }> = {
  EXPIRED: { label: "Ended", tone: "gray" },
  REVOKED: { label: "Stopped", tone: "gray" },
  REJECTED: { label: "Rejected", tone: "red" },
};

function SessionHead({ s }: { s: CafeSessionView }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <div className="font-semibold text-gray-900">{s.cafeName}</div>
        <div className="text-xs text-gray-500">
          Operator: {s.operatorName}
          {s.purpose ? ` · ${s.purpose}` : ""} · asked {timeAgo(s.createdAt)}
        </div>
      </div>
    </div>
  );
}

export default async function CafeAccessPage() {
  const user = await requirePageUser();
  const data = await myCafeAccess(user);

  return (
    <>
      <PageHeader
        title="Café access"
        description="Let a cyber café fill a form for you — only the details you choose, only for as long as you choose. You can stop it any time, and everything the café does is listed here."
      />

      {data.pending.length > 0 && (
        <Card title="Requests waiting for you" className="border-amber-200" actions={<Badge tone="amber">{data.pending.length}</Badge>}>
          <ul className="space-y-6">
            {data.pending.map((s) => (
              <li key={s.id} id={s.id} className="space-y-3">
                <SessionHead s={s} />
                <Alert />
                <ApproveRequest id={s.id} requested={s.permissions} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Give a café a one-time code">
          <p className="mb-3 text-sm text-gray-600">At the café? Choose what they may use, create a code and read it out. No password is ever shared.</p>
          <CodeGenerator />
        </Card>
        <Card className="lg:col-span-2" title="Active now" actions={data.active.length ? <Badge tone="green">{data.active.length}</Badge> : undefined}>
          {data.active.length === 0 ? (
            <EmptyState icon={<IconStore size={22} />} title="No café has access">
              Access appears here while a café session is running.
            </EmptyState>
          ) : (
            <ul className="space-y-4">
              {data.active.map((s) => (
                <li key={s.id} className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
                  <SessionHead s={s} />
                  <Perms list={s.permissions} />
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600">
                    <span>Ends {formatDateTime(s.expiresAt)}{s.applications ? ` · ${s.applications} form${s.applications === 1 ? "" : "s"} filled` : ""}</span>
                    <RevokeSession id={s.id} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Past café sessions">
          {data.past.length === 0 ? (
            <EmptyState icon={<IconHistory size={22} />} title="No past sessions" />
          ) : (
            <ul className="-my-2 divide-y divide-gray-100">
              {data.past.slice(0, 20).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-gray-900">{s.cafeName}</span>
                    <span className="block truncate text-xs text-gray-500">
                      {s.operatorName} · {formatDateTime(s.approvedAt ?? s.createdAt)}
                      {s.applications ? ` · ${s.applications} form${s.applications === 1 ? "" : "s"}` : ""}
                    </span>
                  </span>
                  <Badge tone={STATUS[s.status]?.tone ?? "gray"}>{STATUS[s.status]?.label ?? s.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="What cafés did with your data">
          {data.log.length === 0 ? (
            <EmptyState icon={<IconShield size={22} />} title="Nothing recorded">
              Every request, use of your details and filled form by a café is listed here.
            </EmptyState>
          ) : (
            <ul className="-my-1 space-y-0.5">
              {data.log.slice(0, 30).map((l, i) => (
                <li key={i} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                  <span className="min-w-0 truncate text-gray-700">
                    <b className="font-medium">{l.actorName}</b> · {actionLabel(l.action)}
                  </span>
                  <time className="shrink-0 text-xs text-gray-400" dateTime={l.at}>
                    {timeAgo(l.at)}
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

function Alert() {
  return (
    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
      Approve only if you are at this café right now and asked them to fill a form. You can untick anything you do not want to share.
    </p>
  );
}
