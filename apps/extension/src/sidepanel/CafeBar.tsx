import { useState } from "react";
import { redeemCafeCode, type CafeSessionOption } from "./api";

export function CafeBar({
  cafe,
  selected,
  busy,
  onSelect,
  onRedeemed,
}: {
  cafe: { name: string; sessions: CafeSessionOption[] };
  selected: string | null;
  busy: boolean;
  onSelect: (id: string | null) => void;
  onRedeemed: (id: string) => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const current = cafe.sessions.find((s) => s.id === selected);
  const minsLeft = current ? Math.max(0, Math.round((new Date(current.expiresAt).getTime() - Date.now()) / 60000)) : 0;

  return (
    <div className={`card cafe${current ? " on" : ""}`}>
      <div className="row-between">
        <div className="eyebrow">{cafe.name} · café mode</div>
        {current && <span className="tag review">{minsLeft} min left</span>}
      </div>
      <label className="small">
        Filling for
        <select className="answer" value={selected ?? ""} disabled={busy} onChange={(e) => onSelect(e.target.value || null)}>
          <option value="">Myself (my own profile)</option>
          {cafe.sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.customerName}
              {s.purpose ? ` — ${s.purpose}` : ""}
            </option>
          ))}
        </select>
      </label>
      {current && (
        <div className="small muted">
          Shared by the customer: {current.permissions.join(", ").replace(/_/g, " ")}. Everything you do is shown to them.
        </div>
      )}
      <form
        className="redeem"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          setRedeeming(true);
          try {
            const r = await redeemCafeCode(code);
            setCode("");
            await onRedeemed(r.sessionId);
          } catch (e2) {
            setErr(e2 instanceof Error ? e2.message : String(e2));
          } finally {
            setRedeeming(false);
          }
        }}
      >
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Customer code XXXX-XXXX" aria-label="Customer code" maxLength={12} autoComplete="off" />
        <button className="secondary" disabled={redeeming || code.replace(/[\s-]/g, "").length < 8}>
          Start
        </button>
      </form>
      {err && <div className="small" style={{ color: "var(--err)" }}>{err}</div>}
    </div>
  );
}
