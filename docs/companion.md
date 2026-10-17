# Local companion (Phase 6)

The companion is a small Node.js command-line program that runs on **your own computer** and does approved work
for the AI Form Assistant: list and summarise files, organise a folder (after you approve a preview), write a file
report, and run allowlisted project commands such as `npm test`. Every change asks for your approval in the
dashboard first.

How it is built:

- It only connects **out** to your server over HTTPS (plain `http://` only for `localhost`). It opens no port, so no
  website or other computer can reach it.
- A newly paired computer may do **nothing**. You allow capabilities per computer on the dashboard's **Computer**
  page.
- Folders are approved **only on the computer**, with `folders add`. The dashboard can remove a folder but can never
  add one, so a compromised server cannot widen what the companion can touch.
- The companion cannot be granted your home folder, a drive root, system or application-data folders, or credential
  stores (`.ssh`, `.aws`, browser profiles and so on). Inside an approved folder it skips key files, `.env` files,
  password databases, browser cookie and login files, and `.git` and `node_modules`.
- Moves never delete a file and never overwrite one, and each move is logged so it can be undone. Reports are always
  written as new files.
- Commands come from a fixed list: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `git status`,
  `git diff --stat` and `python -m pytest`. They run with no shell, with a timeout and an output limit, and with a
  minimal environment that does not include the device token.
- It refuses to run as Administrator or root.
- This version has **no screen capture, no mouse control and no keyboard control.**

## Requirements

- Node.js 20 or newer, the same version the project uses.
- A copy of this repository on the computer. The companion loads its PDF and DOCX readers from the repository's
  `node_modules`.
- The server must have `COMPANION_ENABLED=true` set in its `.env`. Restart the app after changing it.

## Install

Run these from the repository folder, in a normal (not Administrator) terminal:

```bash
npm install
```

```bash
npm run build:companion
```

The bundle is written to `apps/companion/dist/companion.mjs`. The commands below use the shortcut
`npm run companion -- <command>`; running `node apps/companion/dist/companion.mjs <command>` works the same way.

## Pair

```bash
npm run companion -- pair --server https://your-domain.example --name "My laptop"
```

The companion shows an 8-character code such as `ABCD-2345`. To pair:

1. Open **Dashboard → Computer (companion)**.
2. Enter the code and press **Check**.
3. Make sure the computer name is yours, then press **Yes, pair it**.

The code is valid for 10 minutes and can be used once. Once you confirm, the companion receives its device token
and saves it here, readable only by your user:

- Windows: `%APPDATA%\ufa-companion\config.json`
- macOS and Linux: `~/.config/ufa-companion/config.json`

You can change this location with the `UFA_COMPANION_HOME` environment variable. The token is never printed.

## Allow capabilities and approve folders

1. On the **Computer** page, tick what this computer may do. Every option starts switched off.
2. On the computer, approve folders. A folder gets read access by default; add `--write` to allow moving files and
   writing reports in it, or `--run` to allow commands to run in it:

```bash
npm run companion -- folders add "C:\Users\me\Documents\Invoices"
```

```bash
npm run companion -- folders add "C:\Users\me\Downloads" --write
```

```bash
npm run companion -- folders add "C:\Users\me\code\my-app" --run
```

`folders list` shows your folders. `folders remove <label>` removes one.

## Run

```bash
npm run companion -- run
```

The companion works only while this command is running. Stop it with Ctrl+C. `run --once` processes waiting steps
and exits after about 10 seconds with nothing to do.

To give it work, open the **Computer** page and type a request in **Ask your computer to do something**, for example
"Summarise the PDFs in Invoices" or "Organise Downloads by type". Press **Show the plan**, check the steps and any
missing permissions, then press **Run**. The task page shows its progress and asks for your approval before anything
changes.

## Stop, revoke, unpair

- **Emergency stop** (on the Computer page, for all computers or for one):
  - The running action is interrupted at the companion's next check, about every 5 seconds.
  - A running command is killed together with its child processes.
  - No new work starts, and the computer's tasks are paused.
  - Clearing the stop does **not** resume tasks; resume each task yourself.
- **Revoke** a computer on the dashboard to end its token for good and cancel its unfinished tasks.
- **Unpair** from the computer:

```bash
npm run companion -- unpair
```

This revokes the computer and deletes the saved token. The undo logs are kept.

## Remote use: from your phone, always on, servers, several computers

### Control your computer from your phone

- Open your server's dashboard (`https://your-domain`) on your phone and go to **Computer (companion)**.
- The page shows each computer's status (online, offline or stopped) and a **Waiting for your approval** list.
  You can approve or reject each action there; one approval allows exactly one action.
- The red **Emergency stop** button stays at the top of the page.
- Nothing extra is opened on your computer or router: the companion still only connects out to your server.

### Keep the companion running (always on)

To start the companion automatically, run this once on each computer:

```bash
npm run companion -- autostart enable
```

- **Windows:** this adds `ufa-companion.cmd` to your Startup folder.
  - At sign-in, a minimised window titled "AI Form Assistant companion (close to stop)" opens. Close the window to stop the companion.
  - It never runs hidden and never runs as Administrator.
  - The computer must be on and signed in for it to work.
- **Linux (desktop or server):** this writes a systemd **user** service, `~/.config/systemd/user/ufa-companion.service`. Then run:

```bash
systemctl --user daemon-reload
```

```bash
systemctl --user enable --now ufa-companion
```

  On a server with no desktop login, also run this once so the service keeps running after you log out:

```bash
loginctl enable-linger $USER
```

  Logs: `journalctl --user -u ufa-companion -f`. The service has `NoNewPrivileges=true`, and the companion refuses to run as root.
- **macOS:** not automated yet. Run it in a terminal or add it to your login items yourself.

`autostart disable` removes the automatic start. `status` shows whether it is on.

### A remote server (for example a second VPS or a cloud machine)

1. On that server, create a normal user (not root).
2. As that user, clone the repository, then run `npm install` and `npm run build:companion`.
3. Pair it from an SSH session:

```bash
npm run companion -- pair --server https://your-domain --name "Cloud server"
```

4. Approve project folders. System folders such as `/etc`, `/usr` and `/var` cannot be granted, so keep projects under your home folder or `/srv`:

```bash
npm run companion -- folders add /srv/my-app --run
```

5. Turn on automatic start as described above, with `enable-linger`.

### Several computers

Each computer is paired on its own and has its own capabilities, folders, AI consent and emergency stop. The
dashboard shows all of them. In a request, name the computer ("on Office PC …") or say "on all computers".

## Multi-agent missions

A mission is one request with several steps, handled by a team of agents:

| Agent | Does |
|---|---|
| Planner agent | Splits your request into steps at "then", ";", new lines or "aur phir". It picks the computer for each step ("on Office PC", "on all computers", otherwise the chosen default) and plans each step. Steps it cannot plan come back as a question |
| File agent | Summarises, organises, writes reports and undoes changes on a computer |
| Command agent | Runs allowlisted project commands on a computer |
| Reviewer agent | When every step is done, writes one review from the results (counts, verdicts), never from file contents |

Rules:

- Planning creates nothing. Before a mission starts, permissions are checked again for every step.
- Steps run in order. A step for "all computers" runs on each computer at the same time.
- Every step is a normal task with its own approvals. A mission never gets more permissions than its tasks.
- A failed step pauses the mission. You choose **Retry this step**, **Skip it** or **Cancel mission**. Nothing is retried automatically.
- The emergency stop pauses every mission that uses a stopped computer. A mission does not resume on its own.

Example request: *"Summarise the files in Invoices on Home PC, then on Office PC run the tests in my-app, then create a
csv report of the invoices in Invoices"*. Missions are listed under **Missions** in the dashboard.

## AI and privacy

| Setting | What it means |
|---|---|
| Default | Summaries are made **on the computer** from the first lines of each file (no AI); ID numbers (Aadhaar, PAN and similar) are masked. The summary text is stored encrypted on the server so you can read it on the task page |
| "Send short excerpts to this server's AI" | Up to 1 500 characters per file (masked) go to the server's **self-hosted** model for a better summary or command explanation |
| "…also to cloud AI" | Only if no self-hosted model is configured: the excerpts may go to Google Gemini. This also needs your global cloud-AI switch and is limited by `COMPANION_AI_DAILY_LIMIT` |

Plans are made from your typed request only; file contents never reach the planner. Nothing is used to train a model.
Ollama running on your computer is detected and shown, but this version does not use it.

## Troubleshooting

| Message | Fix |
|---|---|
| `Refusing to run as Administrator/root` | Open a normal terminal |
| `The server address must start with https://` | Use your domain with HTTPS (`http://localhost` is allowed for development) |
| `The local companion is not enabled on this server` (404) | Set `COMPANION_ENABLED=true` on the server and restart the app |
| `The server no longer accepts this device` | The computer was revoked; pair it again |
| A task waits with "needs your computer" | Start `npm run companion -- run` on that computer |
| `npm was not found next to Node.js` (Windows) | Reinstall Node.js with npm; the companion runs npm through Node directly, without a shell |
