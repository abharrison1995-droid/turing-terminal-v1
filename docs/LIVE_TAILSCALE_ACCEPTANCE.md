# Live phone and Tailscale acceptance

**Status: AWAITING PHYSICAL ACCEPTANCE.** The current development host has no Tailscale CLI or physical phone attached. Record outcomes on the actual desktop and phone; do not mark a step passed from API tests alone.

## Main desktop

1. Install and sign in to Tailscale on the desktop with the same user identity used by the phone. Confirm `tailscale status` shows this device as connected.
2. Start the local master. For a packaged Linux install, use the user service from [Desktop Master](DESKTOP_MASTER.md). Otherwise, from the project root run `npm run build` and `npm start`.
3. Confirm the master is still loopback-only at `127.0.0.1:4317`. In Turing Terminal, open **Settings → Tailscale readiness**. Expected: Tailscale is installed and running; the card returns only this node's hostname/IP and no peer list.
4. Configure persistent Tailscale Serve and inspect it:

   ```sh
   tailscale serve --bg 4317
   tailscale serve status --json
   ```

   Expected: Serve reports an HTTPS `*.ts.net` URL proxying to `127.0.0.1:4317`. The settings check should report the loopback Serve target. Do not use Funnel or expose port 4317 directly. Tailscale documents `tailscale serve status --json` as its machine-readable Serve status command and recommends keeping identity-header-backed services on localhost ([Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve), [Serve security guidance](https://tailscale.com/docs/features/tailscale-serve)).

5. Copy the exact HTTPS Serve address from the CLI. In **Settings → Paired devices**, enter that origin in **HTTPS Tailscale Serve address for QR**, then create a pairing code. Expected: the desktop shows a QR and a separate five-minute manual code. The QR URL contains only the HTTPS origin and a short-lived request UUID; no code, cookie, or provider credential.

## Phone pairing and installation

6. Install/sign in to Tailscale on the phone as the same user. Open the desktop's exact HTTPS Serve URL in the phone browser.
7. Scan the desktop QR with the phone camera. Expected: the browser opens the Turing pairing screen with a QR request detected and no code in the URL after the page loads. Enter a device name and tap **Request approval**. For fallback, create another desktop code and enter it manually instead.
8. On the desktop, confirm the request shows the expected device name and Tailscale user. Tap **Approve**. Expected: the phone reaches the workspace and can load the selected master's dashboard. Provider credentials remain on the desktop.
9. Install the PWA from the browser: on Android/Chrome, use the browser's **Install app** or **Add to Home screen** action; on iPhone, use Safari **Share → Add to Home Screen**. Launch it from the new icon. Expected: it opens as the Turing app and remains associated with this master's HTTPS origin.

## Remote run, approval, intervention, and reconnect

10. On the desktop, create a small test project and a temporary workflow with exactly one enabled **Human approval** stage. Select a project and run this task: `Phone acceptance check; no repository changes are required.` Preview should show the selected machine, project, workflow, permission mode, stage, and run limits. Start the run.
11. Wait until the desktop shows **Waiting for approval**. Lock the phone for at least 30 seconds. Expected: the desktop run remains alive and waiting. If Web Push is configured and enabled, an approval notification should arrive subject to the phone OS/browser relay; otherwise unlock/reopen the PWA to check.
12. Unlock/reopen the PWA. Expected: it reconnects to the same master and shows the pending approval. Approve it from the phone. Expected: the approval is recorded and the no-op workflow completes.
13. Start a second run with the same workflow and wait for the approval. On the phone, submit an intervention message such as `Pause this acceptance run.` Expected: the active approval wait is interrupted, run state becomes paused, and the master retains its run record. Resume from the phone; expected: it returns to the approval gate and completes after approval.
14. While a run is pending, fully close the PWA, then relaunch it from its icon. Expected: the selected master and persisted run state reload; closing the client does not cancel the run.

## Revocation

15. On desktop, open **Settings → Paired devices** and revoke the phone. On the phone, refresh the dashboard and attempt another API-backed action. Expected: the remote session is rejected and the phone returns to the pairing gate. Create and approve a fresh request only if continuing testing.

## Record results

| Check                                          | Result | Evidence / notes |
| ---------------------------------------------- | ------ | ---------------- |
| Tailscale running and Serve points to loopback | ☐      |                  |
| QR claim and desktop approval                  | ☐      |                  |
| Manual code fallback                           | ☐      |                  |
| PWA install and relaunch                       | ☐      |                  |
| Locked phone, reconnect, remote approval       | ☐      |                  |
| Intervention, pause, and resume                | ☐      |                  |
| Run persists after closing PWA                 | ☐      |                  |
| Device revocation blocks API access            | ☐      |                  |
| Closed-client push (if configured)             | ☐      |                  |
