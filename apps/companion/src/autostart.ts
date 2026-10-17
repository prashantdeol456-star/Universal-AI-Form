import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Start the companion automatically, so the computer can be used from a phone or another place
 * (Phase 8). Always visible and always the user's own choice:
 *  - Windows: a .cmd in the user's Startup folder opens a minimised, titled console window at
 *    sign-in (close it to stop). Never hidden, never as Administrator.
 *  - Linux (desktop or server): a systemd *user* service; on a server, "loginctl enable-linger"
 *    keeps it running without a login. Never as root.
 *  - macOS: not automated in this version (instructions only).
 */
const NAME = "ufa-companion";

export function cliPath(): string {
  return process.argv[1] ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url);
}

export function startupTarget(): { kind: "windows" | "systemd" | "manual"; file: string | null } {
  if (process.platform === "win32") {
    const dir = process.env.UFA_STARTUP_DIR ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    return { kind: "windows", file: path.join(dir, `${NAME}.cmd`) };
  }
  if (process.platform === "linux") {
    const dir = process.env.UFA_SYSTEMD_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "systemd", "user");
    return { kind: "systemd", file: path.join(dir, `${NAME}.service`) };
  }
  return { kind: "manual", file: null };
}

const q = (s: string) => `"${s.replace(/"/g, "")}"`;

export function startupContent(kind: "windows" | "systemd", node: string, cli: string, home: string | null): string {
  if (kind === "windows") {
    const env = home ? `set "UFA_COMPANION_HOME=${home.replace(/"/g, "")}"\r\n` : "";
    return `@echo off\r\nrem AI Form Assistant companion: opens a minimised window at sign-in. Close the window to stop it.\r\n${env}start "AI Form Assistant companion (close to stop)" /min ${q(node)} ${q(cli)} run\r\n`;
  }
  return [
    "[Unit]",
    "Description=AI Form Assistant local companion (approved actions only)",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${q(node)} ${q(cli)} run`,
    ...(home ? [`Environment=${q(`UFA_COMPANION_HOME=${home}`)}`] : []),
    "Restart=on-failure",
    "RestartSec=15",
    "NoNewPrivileges=true",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function enableAutostart(): string {
  const t = startupTarget();
  if (!t.file) return "Automatic start is not set up on this system yet. Run the companion in a terminal, or use your system's login items.";
  mkdirSync(path.dirname(t.file), { recursive: true });
  writeFileSync(t.file, startupContent(t.kind as "windows" | "systemd", process.execPath, cliPath(), process.env.UFA_COMPANION_HOME ?? null), { mode: 0o644 });
  if (t.kind === "windows") return `Added to Startup: ${t.file}\nAt sign-in a minimised window "AI Form Assistant companion" opens; close it to stop. Remove with: autostart disable`;
  return `Wrote ${t.file}\nNow run:\n  systemctl --user daemon-reload\n  systemctl --user enable --now ${NAME}\nOn a server (no desktop login), also run once: loginctl enable-linger $USER\nLogs: journalctl --user -u ${NAME} -f`;
}

export function disableAutostart(): string {
  const t = startupTarget();
  if (!t.file || !existsSync(t.file)) return "Automatic start was not set up.";
  rmSync(t.file);
  return t.kind === "systemd" ? `Removed ${t.file}. Also run: systemctl --user disable --now ${NAME}` : `Removed from Startup: ${t.file}`;
}

export const autostartEnabled = () => {
  const t = startupTarget();
  return Boolean(t.file && existsSync(t.file));
};
