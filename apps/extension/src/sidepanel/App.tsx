import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ensureServerPermission, login, loginMfa, logout, me, type Me } from "./api";
import { Compose } from "./Compose";
import { TasksView } from "./TasksView";
import { Main } from "./MainView";
import { DEFAULT_SERVER_URL, getServerUrl, getSession, setServerUrl } from "./storage";

type View = "loading" | "login" | "main" | "settings";

export function App() {
  const [view, setView] = useState<View>("loading");
  const [user, setUser] = useState<Me | null>(null);
  const [server, setServer] = useState(DEFAULT_SERVER_URL);
  const [mode, setMode] = useState<"fill" | "email" | "tasks">("fill");

  const refreshUser = useCallback(async () => {
    setServer(await getServerUrl());
    if (!(await getSession())) return setView("login");
    try {
      setUser(await me());
      setView("main");
    } catch {
      setView("login");
    }
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="3" width="14" height="18" rx="2" />
              <path d="M9 8h6M9 12h6M9 16h3" />
            </svg>
          </span>
          <span className="ellipsis">
            AI Form Assistant <span className="muted small">· {safeHost(server)}</span>
          </span>
        </div>
        {view !== "loading" && (
          <button className="link" onClick={() => setView(view === "settings" ? (user ? "main" : "login") : "settings")}>
            {view === "settings" ? "Back" : "Settings"}
          </button>
        )}
      </header>
      {view === "loading" && <p className="muted pad">Loading…</p>}
      {view === "login" && <Login server={server} onDone={refreshUser} />}
      {view === "settings" && (
        <Settings
          server={server}
          user={user}
          onSaved={async () => {
            setUser(null);
            await refreshUser();
          }}
          onLogout={async () => {
            await logout().catch(() => {});
            setUser(null);
            setView("login");
          }}
        />
      )}
      {view === "main" && user && (
        <>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={mode === "fill"} onClick={() => setMode("fill")}>
              Fill form
            </button>
            <button role="tab" aria-selected={mode === "email"} onClick={() => setMode("email")}>
              Write email
            </button>
            <button role="tab" aria-selected={mode === "tasks"} onClick={() => setMode("tasks")}>
              Tasks
            </button>
          </div>
          {/* Both stay mounted so switching tabs keeps the analysed form and the email chat. */}
          <div hidden={mode !== "fill"}>
            <Main user={user} server={server} onSignedOut={() => setView("login")} />
          </div>
          <div hidden={mode !== "email"}>
            <Compose server={server} />
          </div>
          {/* Mounted only while open, so it polls the server only when visible. */}
          {mode === "tasks" && <TasksView server={server} />}
        </>
      )}
    </div>
  );
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// --- Login -------------------------------------------------------------------------

function Login({ server, onDone }: { server: string; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfa, setMfa] = useState<{ token: string; remember: boolean } | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      if (!(await ensureServerPermission())) throw new Error(`Allow the extension to connect to ${safeHost(server)} to sign in.`);
      const remember = f.get("remember") === "on";
      const challenge = await login(String(f.get("email")), String(f.get("password")), remember);
      if (challenge) setMfa({ token: challenge.mfaToken, remember });
      else onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!mfa) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await loginMfa(mfa.token, String(f.get("code") ?? ""), mfa.remember);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (mfa) {
    return (
      <form className="pad stack" onSubmit={submitCode}>
        <h2>Two-step verification</h2>
        <p className="muted small">Enter the 6-digit code from your authenticator app (or a recovery code).</p>
        {error && <div className="alert">{error}</div>}
        <label>
          Code
          <input name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus maxLength={20} />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? "Checking…" : "Verify"}
        </button>
        <button type="button" className="link" onClick={() => setMfa(null)}>
          Back
        </button>
      </form>
    );
  }

  return (
    <form className="pad stack" onSubmit={submit}>
      <h2>Sign in</h2>
      <p className="muted small">Use the same account as your dashboard. The extension only talks to your server.</p>
      {error && <div className="alert">{error}</div>}
      <label>
        Email
        <input name="email" type="email" autoComplete="username" required />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <label className="check">
        <input type="checkbox" name="remember" /> Keep me signed in on this computer
      </label>
      <button className="primary" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <button type="button" className="link" onClick={() => chrome.tabs.create({ url: `${server}/signup` })}>
        No account? Create one
      </button>
    </form>
  );
}

// --- Settings ----------------------------------------------------------------------

function Settings({ server, user, onSaved, onLogout }: { server: string; user: Me | null; onSaved: () => void; onLogout: () => void }) {
  const [value, setValue] = useState(server);
  const [msg, setMsg] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const u = new URL(value.trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      if (u.protocol === "http:" && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) {
        return setMsg("Use https:// for a real server (http is only allowed for localhost).");
      }
      await setServerUrl(u.origin);
      onSaved();
    } catch {
      setMsg("Enter a valid address, e.g. https://forms.example.com");
    }
  }

  return (
    <div className="pad stack">
      <h2>Settings</h2>
      <form className="stack" onSubmit={save}>
        <label>
          Server address
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://forms.example.com" />
        </label>
        <p className="muted small">Your self-hosted server (for example your Hostinger VPS domain). Changing it signs you out.</p>
        {msg && <div className="alert">{msg}</div>}
        <button className="primary">Save</button>
      </form>
      {user && (
        <div className="card">
          <div>
            Signed in as <b>{user.fullName}</b>
          </div>
          <div className="muted small">{user.email}</div>
          <button className="secondary" onClick={onLogout}>
            Sign out
          </button>
        </div>
      )}
      <p className="muted small">
        Privacy: the extension reads a page only when you press Analyze (or on sites you allowed). It sends field labels and
        types to your server — never what you typed, and never the page itself. It never submits forms and never solves
        CAPTCHA/OTP.
      </p>
    </div>
  );
}
