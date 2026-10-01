# Mobile access

The PWA can control a desktop master over Tailscale Serve. The master continues to bind to loopback; do not set `TT_HOST` to a LAN or Tailscale address and do not expose the port with Funnel, a router, or a public proxy.

## Set up remote access

1. Start the master on the desktop with `npm start`.
2. Configure Tailscale Serve to proxy the local service: `tailscale serve --bg 4317`. Tailscale Serve provides the HTTPS tailnet address; the Tailscale user identity headers are trusted because the backend remains loopback-only.
3. Open that HTTPS address on the phone while signed in to the same Tailscale user. The phone must use a user identity that Tailscale Serve exposes; tagged devices without a user identity are not supported by this pairing flow.
4. In the desktop UI, open **Settings → Paired devices → Create pairing code**. Enter the displayed 16-character, five-minute code and a device name on the phone.
5. Approve the claimed device on the desktop. The phone receives an `HttpOnly`, `Secure`, `SameSite=Strict` cookie bound to the Tailscale user and this machine. The app database stores only the token hash.

The desktop can list devices, see their last-seen time and expiry, and revoke a device. Device sessions expire after 90 days. A revoked, expired, or differently signed-in device cannot call the remote API. Provider credentials never leave the desktop. The PWA does not place the device token in JavaScript storage.

Tailscale networking provides reachability and an authenticated user identity; Turing still requires its separate device approval and cookie. Keep Tailscale Serve within a trusted tailnet and configure its ACLs deliberately. The **Machines** page can save multiple master profiles on that browser and switch by opening the selected master's own HTTPS origin. A profile stores only its origin, name, and non-secret machine metadata; the browser carries the profile list to the selected origin and removes the transfer query parameter immediately. The device cookie remains scoped to that origin, so pair separately with every master. Runs use the selected origin's local API and are never failed over to another machine. A profile's health status is a no-credential reachability probe; project/provider/run details are shown after selecting that master. There is no central aggregator or Turing cloud service.

Grant access to the Serve node only to intended, user-owned devices through your tailnet ACLs. Tailscale Serve does not provide the user identity header for tagged devices, and this pairing flow rejects requests without that identity. Do not grant tagged or otherwise identity-less devices access expecting the Turing approval screen to compensate for it.

## Mobile behavior and limits

The responsive PWA supports machine selection, task entry, workflow/profile selection, run preview, start/stop, progress, approvals, prompt refinement, interventions, diff, findings, history, and usage through the selected desktop. The master owns run processes, so closing or locking the phone does not stop a run; reconnecting reloads persisted state.

Voice input depends on browser speech-recognition support and always leaves the transcript for the user to review before launch. The service worker caches the static shell, not API responses. Browser notifications work while the app is open.

Closed-client notifications use standards-based Web Push when the master has VAPID keys configured and the browser grants notification permission. Create a stable key pair once with `node --input-type=module -e "import webpush from 'web-push'; console.log(JSON.stringify(webpush.generateVAPIDKeys(), null, 2))"`, then configure `TT_WEB_PUSH_PUBLIC_KEY`, `TT_WEB_PUSH_PRIVATE_KEY`, and `TT_WEB_PUSH_SUBJECT` for the master. Keep the private key local and back it up securely; changing it invalidates existing browser subscriptions. In Settings, enable **Closed-client push** on each browser/device.

The master sends encrypted Web Push directly to the subscription endpoint supplied by the browser. Browsers use their vendor push relay (for example, the browser vendor's push service) to deliver after the page closes, so those services and network access are required. Turing Terminal does not operate a central push server. Delivery while a phone is locked depends on the platform's browser/PWA support, power settings, and its push service; verify it on the actual phone. Events include approvals, clarification requests, run completion/failure, provider authentication errors, and configured quota-envelope thresholds. Notification text is generic and excludes task prompts, logs, and credentials.

VAPID keys are absent by default. Without them, open-client browser notifications remain available and the Settings page shows that closed-client push is unconfigured. Push subscriptions are capped at 20 per master and accepted only for known browser push-service domains.

Pairing supports both a QR request and the manual short-lived code fallback. The QR carries only the HTTPS Serve origin and a short-lived request UUID. The phone claims it through Tailscale identity; desktop approval is still required before a scoped expiring device cookie is issued. A real phone/Tailscale acceptance run and a two-master routing run have not been performed in this environment. Follow [Live Tailscale acceptance](LIVE_TAILSCALE_ACCEPTANCE.md) and [Live multi-machine acceptance](LIVE_MULTIMACHINE_ACCEPTANCE.md); API and profile tests do not prove end-to-end network behavior.
