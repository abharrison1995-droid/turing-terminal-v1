# Goal trusted-caller boundary (S1)

Status: threat model and design checkpoint, 2026-10-13. S1a is implemented by GH.1. S1b is an open owner decision. The options and recommendation below are for the owner. They are not a decision, and they do not change release status (see [V1_READINESS.md](../V1_READINESS.md)).

## 1. Problem

The Goal completion and correction routes record authority: user decisions that approve an attestation, a completion, or a correction. The phone is a remote control and must not make those decisions. Before GH.1 the server had one remote predicate for the whole API and did not refuse paired devices on these routes, so a paired phone could call them directly.

## 2. Trust channels as implemented

- **Bind.** The API listens on `TT_HOST`, which defaults to `127.0.0.1` (`src/server/index.ts`). The readiness route reports `unsafe_master_binding` when the bind is not loopback (`src/server/app.ts`, about line 519).
- **Local.** No `tailscale-user-login` header, and the Host and Origin hostnames are loopback (`localhost`, `127.0.0.1`, `::1`, `tauri.localhost`). Ports are not compared.
- **Remote.** The identity header is present, or Host or Origin is non-loopback or missing. A remote request needs the `__Host-turing-device` cookie. That cookie must match an unexpired, non-revoked `device_sessions` row bound to the same normalized Tailscale login. Tokens are stored as SHA-256 hashes. Without a valid cookie the global pre-handler answers `401`.
- **Pairing.** A pairing request is created on the desktop. A claim needs the identity header and the code. The desktop approves it, and completion with the identity sets the cookie. Pairing administration answers `403` to remote callers.
- **CORS.** The `onRequest` hook reflects only `tauri://localhost` and `http://tauri.localhost`, and allows `content-type, if-match` headers. No other origin receives CORS headers.

The predicate that produces "remote" is `isRemoteRequest` in `src/server/app.ts`. The Goal routes receive it as `requireDesktopCaller`. It is not reimplemented anywhere else.

## 3. What the server can and cannot distinguish

The server can distinguish:

- a request that carries a Tailscale identity from one that does not;
- which device session presented a token, and whether it is bound to the identity;
- loopback Host and Origin from non-loopback values.

The server cannot distinguish:

- which process on the desktop machine sent a local request;
- whether a human clicked anything;
- a request from a browser page served from another localhost port, because the loopback check compares hostnames, not ports;
- whether an identity header was added by Tailscale Serve, or by something else that reached the port;
- whether a request whose Host was rewritten to loopback came from a phone. Any identity-less request with a loopback Host is classified as local.

## 4. Actors

| Actor                                  | Path to the API                                  | Current behaviour                                                                         | Covered by GH.1                                    | Residual                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paired phone, same user                | Tailscale Serve, identity header, device cookie  | Ordinary routes allowed; the five routes refused                                          | Yes, the five routes return 403 `desktop_required` | None on the five routes, subject to the unverified Serve items in section 8                                                                                                  |
| Unpaired tailnet device, same user     | Serve, identity header, no cookie                | 401 from the global check                                                                 | Not needed                                         | None found in code                                                                                                                                                           |
| Tailnet device of another user         | Serve, other identity, no session for that login | 401; sessions are bound to the login                                                      | Not needed                                         | None found in code                                                                                                                                                           |
| Public internet or Funnel              | No identity header; Host is not loopback         | Treated as remote; 401                                                                    | Not needed                                         | Funnel is not verified (section 8)                                                                                                                                           |
| Browser CSRF from a cross-site page    | Cross-origin request to loopback                 | Origin is non-loopback, so remote; 401                                                    | Not needed                                         | Code reading only: the five routes also need an `If-Match` header, which forces a CORS preflight that the server does not grant to non-Tauri origins. Not tested separately. |
| Browser page on another localhost port | Loopback Origin, different port                  | Treated as local                                                                          | No                                                 | Port is not compared. Cross-origin preflight is still refused as above, so the practical exposure is unproven. Residual.                                                     |
| DNS rebinding on the desktop           | Host is the attacker name, which is non-loopback | Treated as remote; needs a device cookie for that origin, which the browser does not hold | Not needed                                         | Code reading only. Not tested.                                                                                                                                               |
| Same-user local process on the desktop | Loopback, no identity header                     | Treated as local; all routes allowed, including the five                                  | No                                                 | Open. This is S1b.                                                                                                                                                           |
| In-process supervisor and services     | Direct function calls, not HTTP                  | Not affected by the HTTP guard                                                            | Not applicable                                     | The guard is an HTTP-layer check only. Services are trusted code.                                                                                                            |

The same-user row is the residual that S1a does not close. A same-user process can already read the local database file, which is created with mode `0600` and is still readable by its owner (see `docs/SECURITY.md`).

## 5. S1a: implemented in GH.1

- Five `POST` routes in `src/server/goals/goalRoutes.ts` call `deps.requireDesktopCaller(request)` as the first statement of the handler. A refusal is `403` with code `desktop_required`, before the Goal lookup and before body validation.
- `requireDesktopCaller` is a required member of `GoalRouteDeps`. It is supplied in `src/server/app.ts` as `!isRemoteRequest(request.headers, getTailscaleLogin(...))`. A missing wiring is a type error.
- Tests: `src/server/goals/goalDesktopOnly.test.ts` covers local behaviour, remote refusal with an unchanged database, refusal before body validation, the mobile-permitted routes, `401` for missing cookies, and spoofed desktop headers. A static drift test classifies every non-GET route and checks the guard's position.

Limits of S1a:

- It is not S1b. A same-user local process still passes.
- It inherits the predicate's properties: loopback is compared by hostname only, and an identity header is trusted because Serve is expected to supply it.
- It does not change authentication, the global pre-handler, pairing, cookies, sessions or CORS.

## 6. S1b options (owner decision)

**O1: accept the residual and disclose it.** No code change. Document that a same-user local process is trusted, as the local database and provider credentials already are.

- Cost: none.
- Protects against: nothing beyond S1a.
- Does not protect against: a same-user process, a browser page on another localhost port (the port is not compared), or a compromised desktop UI.

**O2: per-launch desktop capability.** The Tauri shell generates a random secret for each launch and passes it to the Master on stdin, not argv or environment. The desktop UI receives it through the Tauri command channel and sends it as a header on the five routes. The server compares it in constant time.

- Cost: changes to the Tauri launcher, a header on the five client calls, a server check, and secret lifecycle handling.
- Protects against: unprivileged same-user processes that cannot read the Master's stdin or the UI's memory, and browser pages, which cannot read the secret.
- Does not protect against: a same-user process that can attach to the desktop UI or the Master, read their memory, or intercept the Tauri command channel; a compromised desktop UI; or a process that can read the Master's stdin pipe.

**O3: O2 plus native OS confirmation.** Each user-only action first shows a confirmation from the Tauri shell, outside the webview, before the request is sent.

- Cost: friction, and platform-specific dialog code.
- Protects against: accidental or scripted use of the UI, if the dialog is not automatable.
- Does not protect against: a process that can drive native dialogs through accessibility or automation APIs, a user who clicks through reflexively, or a process that can forge the O2 capability.

**O4: process isolation.** Authority decisions run in a separate OS account or sandboxed process, with its own key, reached through an authenticated IPC channel.

- Cost: a large architectural change, plus packaging and per-platform account and ACL work, including Windows.
- Protects against: same-user processes, if the isolation is enforced by the operating system.
- Does not protect against: administrator or root, or the same account if the key can be read.

## 7. Recommendation (for the owner; not a decision)

- **For V1: O1, with explicit disclosure** in `docs/SECURITY.md` and `docs/V1_READINESS.md`. The desktop is already the trust root for the local database and provider configuration. A same-user process can already read that data, so O1 adds the least marginal exposure.
- **After V1: O2, as a design with a spike** to measure how the capability is delivered and whether the UI can hold it. O2 closes the browser and unprivileged-process cases, which O1 leaves open.
- **O3 and O4 are not recommended** for V1. O3 adds friction without a stronger boundary. O4 is a larger change than the residual justifies at this stage.

This recommendation is an analysis for the owner. The owner has not yet chosen an option.

## 8. Unverified items

These are not verified by the automated tests or by code reading alone. Each needs live acceptance.

- **Tailscale Serve header handling.** Whether Serve strips a client-supplied `Tailscale-User-Login` header and whether it always injects the real one. Live acceptance is pending (`docs/LIVE_TAILSCALE_ACCEPTANCE.md`).
- **Host rewriting.** Whether Serve or any proxy rewrites Host to a loopback name. If a remote request arrives with a loopback Host and no identity header, the predicate classifies it as local, and GH.1 does not refuse it. This is the most important open item.
- **Non-Serve reverse proxies.** Any proxy that terminates remote traffic and forwards it with a loopback Host and no identity header is classified as local for the same reason.
- **Vite dev proxy.** `vite.config.ts` proxies `/api` to `127.0.0.1:4317` without `changeOrigin`, so the Host seen by the Master is the dev server's Host. This is development only and unverified against remote access.
- **Port-insensitive loopback.** Whether a browser page on another localhost port can use the local path in practice. Only code reading supports the analysis above.
- **Funnel.** Whether Funnel or any public path can reach the API. The service documents no Funnel support, and this is not verified.
- **Windows.** The `tauri.localhost` origin and loopback behaviour on Windows are not verified.
- **Physical devices.** No physical phone or desktop result is established by this document.
