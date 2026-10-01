# Live two-master routing acceptance

**Status: AWAITING TWO-PHYSICAL-MACHINE ACCEPTANCE.** Profile/routing unit tests do not prove that two real masters remain isolated over Tailscale.

## Prepare both machines

1. Choose two real computers on the same tailnet, called **A** and **B**. Install/start a separate Turing Terminal master on each. Keep each bound to `127.0.0.1:4317` on its own host.
2. On each computer, configure `tailscale serve --bg 4317` and verify `tailscale serve status --json` points at that computer's loopback master. Copy the two distinct HTTPS Serve origins.
3. Open A's origin in the mobile browser, pair and approve the phone on A. Repeat separately on B. Expected: the browser's Machines list has two entries with distinct stable machine IDs even if the display names or OS versions match.
4. Confirm each profile reports its own machine identity and that both origins can be probed independently. Do not export provider credentials or database files from either machine.

## Verify routing isolation

5. Add a different tiny test project on A and B. Use distinguishable names, for example `Acceptance project A` and `Acceptance project B`. Create the same no-op workflow on both with one **Human approval** stage.
6. Select profile A in the phone app and start a run for project A. Expected: the run appears only in A's desktop UI/history; A's project path and A's machine ID are in its run preview/history.
7. While A's run is waiting, select profile B and start a run for project B. Expected: B's run appears only on B; the target machine ID and project belong to B.
8. Approve A's pending gate while profile A is selected; then approve B's gate while profile B is selected. Expected: each action affects only that master's run. Confirm one run ID from each API/UI and verify no cross-machine run appears.
9. Stop or disconnect A's master and select A's profile. Expected: A reports offline/unavailable and cannot launch through B. B remains usable. Reconnect A and confirm its previous run history is still there.
10. Verify the same origin-specific revocation behavior: revoke the paired device on A and confirm A rejects the phone while B remains paired; then restore A pairing if needed.

## Record results

| Check                                       | Result | Evidence / notes |
| ------------------------------------------- | ------ | ---------------- |
| Distinct stable A/B machine identities      | ☐      |                  |
| A run routed only to A                      | ☐      |                  |
| B run routed only to B                      | ☐      |                  |
| A outage does not fail over to B            | ☐      |                  |
| A and B sessions/revocation are independent | ☐      |                  |
