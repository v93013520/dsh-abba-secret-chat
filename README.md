# AB-BA Secret Chat · dsh-abba-secret-chat

A one-off, two-person password chat that docks in the **DeepSeek Harness** right sidebar. A and B each set their own password and tell each other; **both passwords must match** to pair. Messages are forwarded in memory only — never stored, never logged. The chat page is served by a small LAN service on this machine and **disappears when DSH exits**.

English | [中文](README.zh.md)

![Two-person chat in the right sidebar](docs/screenshots/01-sidebar-chat.png)

*A “Secret chat” entry appears at the bottom of the left sidebar; the chat opens in the right sidebar next to your main conversation, which keeps working untouched.*

## What it solves

Sometimes you want to say a few private things to someone nearby (a colleague, family member, a friend) without creating accounts, leaving chat history behind, or mixing it into your AI session. Two people each know a password, one click opens a room that only exists while both are in it — and burns after use.

## Features

- **Sidebar chat** — a **🔒 Secret chat** button at the bottom of the left sidebar (icon-only when the sidebar is narrow) opens a “Secret chat” tab in the **right sidebar**; the chat page is embedded inside that tab. It can also be opened from the right sidebar’s “+” page via its guide card. Your main conversation is unaffected.
- **Two-password pairing** — the A field takes A’s password and the B field takes B’s password; only when both are correct do two people meet in the same room. **Swapping the fields still works** (the room key is order-independent, so a mix-up never locks you out).
- **Two people per combination** — a third person using the same two passwords is explicitly rejected. If either side leaves, refreshes, or disconnects, the room is destroyed and both sides are cleared immediately.
- **In-memory only** — the server only relays A → server → B. It stores no messages, writes no logs, and touches no disk (except reading its own bundled `index.html`); everything is gone when the process exits.
- **Works on your LAN** — by default it starts a tiny service on port `8787` bound to the LAN, so the other person can join from a browser on the same Wi-Fi with **nothing installed**. If the port is busy it tries `+1…+9`, then lets the OS pick; the actual port is shown in the panel toolbar and by `/abba`.
- **Zero dependencies, no build step** — no npm runtime dependencies, no `postinstall`, no build scripts. MIT.
- **Tied to DSH’s lifecycle** — the chat service is a component inside the DSH process and closes when DSH exits or the plugin unloads. No resident background process.

## Install

Requires **DeepSeek Harness `>= 0.2.1-rc.3`** (`engines.dsh`; earlier hosts lack the right sidebar and the `sidebarRight` API).

**A. From the market (once listed)**

DSH → left sidebar **Plugins** → **Market** → search `dsh-abba-secret-chat` → Install.

**B. From a local directory (desktop, current dev build)**

DSH desktop → left sidebar **Plugins** → **Install** → choose **local directory** → point at this package → Install, then **fully quit and reopen DSH**.

**C. Command line (plain `dsh web` or a custom profile)**

```powershell
dsh plugin --profile web add dsh-abba-secret-chat
# without an npm mapping yet, install from source:
dsh plugin --profile web add github:v93013520/dsh-abba-secret-chat
```

> The desktop profile is owned by the desktop app’s plugin manager — install through the in-app Plugins page instead of editing `profiles/desktop` by hand.

Restart DSH after installing or updating so the new plugin loads.

## Three-step usage

1. **Agree on passwords** — A and B each pick a password (4–128 chars) and tell each other **out of band** (WeChat, verbally, …).
2. **Both join** — A clicks **Secret chat** in the left sidebar, fills A’s password in the A field and B’s password in the B field, clicks **Start**, and waits. B opens the **peer link** shown in the panel toolbar (e.g. `http://192.168.x.x:8787`) in a browser on the same Wi-Fi and joins with the same two passwords (swapped is fine) — the two are paired automatically.
3. **Chat and end** — Enter or Send delivers in real time. Either side clicking **End chat** (or closing/refreshing the page) destroys the room and clears both sides. A waiting initiator is cancelled automatically after 10 minutes.

> Want to try alone? Open `http://127.0.0.1:8787` in two browser tabs on this machine — one as A, one as B.

## Screens

| Two-password start page | Right-sidebar panel (entry + peer link) |
|---|---|
| ![Start page](docs/screenshots/02-start-page.png) | ![Panel](docs/screenshots/03-panel-and-entry.png) |

## Commands

Type these in the DSH composer:

| Command | Effect |
|---|---|
| `/abba` | Show status, local URL, LAN URL, and how to open the panel |
| `/abba status` | Same as above |
| `/abba stop` | Stop the chat service (the panel stops working) |
| `/abba 9000` | Restart on port 9000 (with the same port fallback) |

## Configuration (optional)

There is no settings UI; to change the port or restrict access to this machine, override the row’s `config` in your profile’s `cordis.patch.yml` (a patch replaces the row’s whole `config`):

```yaml
- id: abba-secret-chat
  name: dsh-abba-secret-chat
  config:
    port: 9000        # default 8787; falls back +1..+9 when busy
    host: 127.0.0.1   # default 0.0.0.0 (LAN reachable); set this for local-only
```

## Privacy and security

- **Memory only** — rooms, members, and messages live in an in-process `Map`; nothing is written to a database or file, and message content is never logged.
- **No browser storage** — the chat page uses no cookies, `localStorage`, or `sessionStorage`; the client id lives in page memory.
- **Two passwords** — both passwords participate in the room key only as SHA-256 hashes held in memory; they are never persisted, echoed back, or logged.
- **Plain HTTP** — the chat page is served over plain HTTP on the LAN (default `0.0.0.0:8787`). Use it only on a trusted network (home/office LAN); put an HTTPS reverse proxy in front for anything beyond that. **Anyone who knows both passwords can join.**
- **Isolated from your DSH session** — the chat page is a separate web page; its content never enters DSH session history and is never sent to a model. The plugin registers no model-facing tools.
- **Lifecycle** — the service starts and stops with the DSH process; there is no resident background process or system service.

## Compatibility

| Host | Notes |
|---|---|
| DSH Desktop `>= 0.2.1-rc.3` | Fully supported (right-sidebar tab, sidebar entry, `/abba`) |
| `dsh web` (same version) | Same right sidebar and entry |
| Older hosts (no right sidebar) | `engines.dsh` not satisfied; the entry degrades to opening the chat page in a browser tab |

## Development and tests

```powershell
# Chat semantics end-to-end (two passwords, swapped fields, third person rejected, leave clears, wait timeout)
node test/host-e2e.mjs

# Host plugin contract (/abba/info shape, port fallback, port release on stop, command surface, never throws)
node test/host-info.mjs

# Offline browser-half test (bundle protocol, slot registrations, rendering, fallbacks)
node test/client-harness.mjs

# Real-browser acceptance (headless Edge + CDP): two-person flow + real chat inside the DSH panel + screenshots
node test/browser-e2e.mjs --dsh "http://127.0.0.1:3099/?token=<token>" --out docs/screenshots
```

Layout:

```
lib/index.js      host plugin entry (server lifecycle, /abba/info route, /abba command)
lib/server.js     the chat service (zero deps; two passwords, SSE, relay-only)
lib/lan.js        LAN address enumeration
assets/index.html the chat page (byte-identical to password-chat/index.html)
client/client.js  browser half: right-sidebar tab + entry button + no-session overlay (hand-written bundle, no build)
cordis.patch.yml  the plugin row (single dual-face package)
```

## License

MIT © wangwei
