# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React and TypeScript for one interface shared by the desktop shell and the phone PWA, with a local Node.js master for orchestration and SQLite persistence. The desktop shell is Tauri, packaged for Windows (NSIS installer) and Linux (.deb and AppImage) as 1.0.0-rc1, and it bundles Node. macOS is not packaged.

## Users

Developers who want to coordinate coding agents and repository workflows from a development computer, with the ability to monitor and control runs from a phone.

V1 is a private tool for its owner and the owner's own machines: the repository is private, installers are unsigned, and each phone is paired and approved per device. Sharing with a team or distributing to other developers is undecided and is not a V1 capability.

## Product Purpose

Turing Terminal is a local-first control plane for coordinating coding agents, development workflows, repositories, machines, tests, reviews, and Git operations. A user should be able to start a configured workflow remotely while the registered desktop machine executes it and retains its state.

## Positioning

Provider-agnostic, model-agnostic, workflow-driven orchestration. Stages use explicitly configured backends and models; the product does not silently substitute a provider or model.

## Operating Context

The desktop master owns repository access, process execution, provider authentication, persistence, and secrets. The mobile PWA is a remote control and never runs agents locally. Private remote connectivity is expected to use Tailscale.

## Capabilities and Constraints

- V1 must not require OpenAI or Anthropic API keys for subscription-backed use.
- Use only documented provider authentication and integration paths; do not route Claude subscription credentials through a prohibited integration.
- Provider capabilities and usage metrics must report their provenance and say unavailable when a provider does not expose data.
- Runs persist their workflow snapshot, stages, events, approvals, interventions, Git state, and locally observed usage.
- Git merges require explicit approval by default, and force push is never automatic.
- Permission modes are Supervised, Normal, YOLO, and Enigma; secret protections remain active in every mode.
- Build/test commands and repository paths must remain under an explicitly registered project.
- Multi-machine routing must bind a run to the selected machine.

## Brand Commitments

Use the name Turing Terminal. The interface should feel like a calm, technical engineering control center: clear, professional, information-dense, and accessible. Avoid hacker-terminal clichés, Matrix green, fake CRT effects, and excessive monospace. The user pinned the look: it resembles the Claude Code and ChatGPT Codex apps (desktop and mobile), in a light theme with light blue as the main colour, calm red and white as accents, and black text. Light blue is the field, white is the work surface, and calm red marks the primary action. Light only; no dark theme is planned. The home is a task-thread workspace (composer first, runs as threads in a task list), not a dashboard of cards.

## Evidence on Hand

The implementation directive is the product brief. There are no supplied logos, customer claims, benchmark claims, pricing claims, or production usage data. Do not invent them.

Release state is 1.0.0-rc1 for acceptance testing. Physical Windows and Linux installs and phone pairing over Tailscale have not yet been verified on real devices (see README and docs/RELEASE_NOTES_1.0.0-rc1.md), so do not present them as proven.

## Product Principles

1. The user chooses each stage's provider and model.
2. Provider limits and unsupported telemetry are disclosed honestly.
3. The desktop retains credentials and performs repository work.
4. Important operations have durable state and an audit trail.
5. The mobile experience controls work without pretending a command was accepted before the desktop confirms it.

## Accessibility & Inclusion

WCAG 2.2 AA is the minimum: 4.5:1 text contrast (3:1 for large text and UI components), visible keyboard focus, full keyboard operability, and adequate target size. The phone, used one-handed and often interrupted, is a primary context, so primary actions must be reachable and legible there. Reduced-motion preferences are honored.
