# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated by the implementation directive: React and TypeScript for the shared desktop/PWA interface, with a local Node.js service for orchestration and SQLite persistence. A native desktop shell remains an open V1 packaging decision.

## Users

Developers who want to coordinate coding agents and repository workflows from a development computer, with the ability to monitor and control runs from a phone.

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

Use the name Turing Terminal. The interface should feel like a calm, technical engineering control center: clear, professional, information-dense, and accessible. Avoid hacker-terminal clichés, Matrix green, fake CRT effects, and excessive monospace. The first implementation should prioritize structure and usability; a later `/impeccable` pass is planned by the user.

## Evidence on Hand

The implementation directive is the product brief. There are no supplied logos, customer claims, benchmark claims, pricing claims, or production usage data. Do not invent them.

## Product Principles

1. The user chooses each stage's provider and model.
2. Provider limits and unsupported telemetry are disclosed honestly.
3. The desktop retains credentials and performs repository work.
4. Important operations have durable state and an audit trail.
5. The mobile experience controls work without pretending a command was accepted before the desktop confirms it.
