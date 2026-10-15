import { checkUrl, SCOPE_TEXT } from "@ufa/form-engine";
import { useCallback, useEffect, useState } from "react";
import type { SitePermission } from "./api";
import { authorizeSite, grantOf, removeSiteAccess, siteGrants } from "./siteAccess";

type Scope = SitePermission["scopes"][number];

/**
 * Current site and what the assistant may do there. The user allows a site explicitly;
 * nothing is read or filled before that.
 */
export function SiteAccessCard({ url, onChange }: { url: string | null; onChange?: (site: SitePermission | null) => void }) {
  const [site, setSite] = useState<SitePermission | null | undefined>(undefined);
  const [want, setWant] = useState<Record<Scope, boolean>>({ inspect: true, fill: true, attach_file: false, insert_text: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = url ? checkUrl(url) : null;

  const load = useCallback(
    async (force = false) => {
      if (!url || !check?.ok) return setSite(null);
      try {
        const s = grantOf(await siteGrants(force), url);
        setSite(s);
        onChange?.(s);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run when the page changes
    [url],
  );
  useEffect(() => void load(), [load]);

  if (!url) {
    return (
      <div className="warn small">
        Chrome has not shared this tab with the assistant. Click the extension icon in the Chrome toolbar while you are on the page.
      </div>
    );
  }
  if (!check?.ok) return <div className="warn small">This page cannot be used: {check?.reason}</div>;

  return (
    <div className="site-access">
      {site ? (
        <div className="row-between">
          <span className="small">
            <span className="badge ok">Allowed</span> {site.scopes.map((s) => SCOPE_TEXT[s]).join(" · ")}
          </span>
          <button
            className="link small"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await removeSiteAccess(site).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
              setBusy(false);
              await load(true);
            }}
          >
            Remove access
          </button>
        </div>
      ) : site === null ? (
        <>
          <div className="small">
            <span className="badge rev">Not allowed</span> The assistant cannot read or fill <b>{check.host}</b> yet.
          </div>
          <div className="scope-list">
            {(["fill", "attach_file", "insert_text"] as const).map((s) => (
              <label key={s} className="check small">
                <input type="checkbox" checked={want[s]} disabled={s === "fill"} onChange={(e) => setWant({ ...want, [s]: e.target.checked })} />
                {s === "fill" ? "Read the form and fill fields I approve" : s === "attach_file" ? "Attach documents I choose" : "Insert drafted email text"}
              </label>
            ))}
          </div>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const scopes = (Object.keys(want) as Scope[]).filter((k) => want[k]);
              const r = await authorizeSite(url, scopes);
              setBusy(false);
              if (!r.ok) return setError(r.error);
              await load(true);
            }}
          >
            Allow on {check.host}
          </button>
        </>
      ) : (
        <p className="muted small">Checking site access…</p>
      )}
      <p className="muted small" style={{ margin: 0 }}>
        Never done for you on any site: Submit, Next / Continue, payments, sending messages, CAPTCHA, OTP and passwords.
      </p>
      {error && <div className="alert">{error}</div>}
    </div>
  );
}
