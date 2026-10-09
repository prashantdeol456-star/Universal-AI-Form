import { CAFE_PERMISSION_LABELS, type CafePermission } from "@ufa/shared";
import { IconCheckCircle, IconForm, IconPuzzle, IconStore, IconUser } from "@/components/icons";
import { Badge, Card, EmptyState, PageHeader, Stat } from "@/components/ui";
import { formatDateTime, statusMeta, timeAgo } from "@/lib/labels";
import { requirePageUser } from "@/server/auth/session";
import { cafeReport, cafeSessions, listOperators, myCafe } from "@/server/cafe/workspace";
import { CloseCafe, CreateCafeForm, EndSession, InviteOperator, OperatorToggle, RedeemCode, RequestAccess } from "./CafeWorkspaceClient";

const minutesLeft = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));

export default async function CafeWorkspacePage() {
  const user = await requirePageUser("cafe:sessions_request");
  const cafe = await myCafe(user);

  if (!cafe) {
    return (
      <>
        <PageHeader title="Café Workspace" description="Fill forms for your customers — with their permission, only what they share, only for as long as they allow." />
        <Card title={user.role === "CAFE_OWNER" ? "Register your café" : "Not part of a café"}>
          {user.role === "CAFE_OWNER" ? (
            <CreateCafeForm />
          ) : (
            <EmptyState icon={<IconStore size={22} />} title="Ask your café owner to invite you">
              Operators are added by the café owner from this page; you will get an e-mail to set your password.
            </EmptyState>
          )}
        </Card>
      </>
    );
  }

  const owner = cafe.myRole === "OWNER";
  const [sessions, operators, report] = await Promise.all([
    cafeSessions(user),
    owner ? listOperators(user) : Promise.resolve([]),
    owner ? cafeReport(user, 30) : Promise.resolve(null),
  ]);
  const active = sessions.filter((s) => s.status === "ACTIVE");
  const pending = sessions.filter((s) => s.status === "PENDING");
  const maxDay = Math.max(1, ...(report?.byDay.map((d) => d.applications) ?? [1]));

  return (
    <>
      <PageHeader
        eyebrow={owner ? "Owner" : "Operator"}
        title={cafe.name}
        description="Customers stay in control: they choose what you may use and for how long, can stop it any time, and see everything you do."
        actions={owner ? <CloseCafe /> : undefined}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Customer is here: enter their code">
          <p className="mb-3 text-sm text-gray-600">
            The customer opens <b>Café access</b> in their account, chooses what to share and reads you an 8-character code.
          </p>
          <RedeemCode />
        </Card>
        <Card title="Or send an access request">
          <p className="mb-3 text-sm text-gray-600">They approve it on their phone and can untick anything they do not want to share.</p>
          <RequestAccess />
        </Card>
      </div>

      <Card title="Active sessions" actions={<Badge tone={active.length ? "green" : "gray"}>{active.length}</Badge>}>
        {active.length === 0 && pending.length === 0 ? (
          <EmptyState icon={<IconPuzzle size={22} />} title="No customer session running">
            Start one above, then open the form and choose the customer in the Chrome extension.
          </EmptyState>
        ) : (
          <ul className="-my-2 divide-y divide-gray-100">
            {[...active, ...pending].map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                    {s.customerName}
                    {s.status === "PENDING" ? <Badge tone="amber">Waiting for approval</Badge> : <Badge tone="green">{minutesLeft(s.expiresAt)} min left</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {s.permissions.map((p: CafePermission) => (
                      <Badge key={p}>{CAFE_PERMISSION_LABELS[p].en}</Badge>
                    ))}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {owner ? `${s.operatorName} · ` : ""}
                    {s.purpose ? `${s.purpose} · ` : ""}
                    {s.applications} form{s.applications === 1 ? "" : "s"} filled
                  </div>
                </div>
                <EndSession id={s.id} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {owner && report && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat icon={<IconForm size={20} />} label="Forms filled (30 days)" value={report.totals.applications} />
            <Stat icon={<IconCheckCircle size={20} />} tone="green" label="Marked submitted" value={report.totals.submitted} />
            <Stat icon={<IconUser size={20} />} tone="amber" label="Customers served" value={report.totals.customers} />
            <Stat icon={<IconStore size={20} />} tone="gray" label="Approved sessions" value={report.totals.sessions} />
          </div>

          <div className="grid gap-6 lg:grid-cols-5">
            <Card className="lg:col-span-3" title="Forms per day (last 30 days)">
              <div className="flex h-36 items-end gap-1" role="img" aria-label={`Forms per day, highest ${maxDay}`}>
                {report.byDay.map((d) => (
                  <div key={d.day} className="group relative flex-1" title={`${d.day}: ${d.applications}`}>
                    <div className="w-full rounded-t bg-brand-500/80 group-hover:bg-brand-600" style={{ height: `${(d.applications / maxDay) * 128 + (d.applications ? 4 : 1)}px` }} />
                  </div>
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-gray-400">
                <span>{report.byDay[0]?.day}</span>
                <span>today</span>
              </div>
            </Card>
            <Card className="lg:col-span-2" title="By operator">
              {report.byOperator.length === 0 ? (
                <p className="text-sm text-gray-500">No activity yet.</p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-gray-500">
                    <tr>
                      <th className="py-1 font-medium">Operator</th>
                      <th className="py-1 text-right font-medium">Forms</th>
                      <th className="py-1 text-right font-medium">Submitted</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {report.byOperator.map((o) => (
                      <tr key={o.operatorId}>
                        <td className="py-1.5">{o.name}</td>
                        <td className="py-1.5 text-right tabular-nums">{o.applications}</td>
                        <td className="py-1.5 text-right tabular-nums">{o.submitted}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Operators">
              <ul className="-my-2 mb-4 divide-y divide-gray-100">
                {operators.map((o) => (
                  <li key={o.cafeUserId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-gray-900">
                        {o.name} {o.role === "OWNER" && <Badge tone="blue">Owner</Badge>}
                      </span>
                      <span className="block truncate text-xs text-gray-500">
                        {o.email}
                        {o.invitedPending ? " · invitation not accepted yet" : ""}
                      </span>
                    </span>
                    {o.role === "OPERATOR" && <OperatorToggle id={o.cafeUserId} status={o.status} />}
                  </li>
                ))}
              </ul>
              <InviteOperator />
            </Card>
            <Card title="Recent forms (no customer data shown)">
              {report.recent.length === 0 ? (
                <p className="text-sm text-gray-500">No forms filled yet.</p>
              ) : (
                <ul className="-my-2 divide-y divide-gray-100">
                  {report.recent.slice(0, 10).map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-gray-900">{a.formName ?? a.domain}</span>
                        <span className="block truncate text-xs text-gray-500">
                          {a.customerName} · by {a.operatorName} · {timeAgo(a.createdAt)}
                        </span>
                      </span>
                      <Badge tone={statusMeta(a.status).tone}>{statusMeta(a.status).label}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}

      {!owner && <p className="text-xs text-gray-400">Signed in as an operator · sessions shown are your own · last refresh {formatDateTime(new Date())}</p>}
    </>
  );
}
