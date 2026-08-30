# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Bun monorepo with a React client, a loopback-only Hono server, AI SDK 6, and
local SQLite persistence. Lightcode also retains its existing OpenTUI terminal
client over the same server APIs.

## Users

Developers working on projects stored on their own computer. They choose either
the terminal interface or a browser interface, select a local project, and ask
Lightcode to understand or change that project.

## Product Purpose

Lightcode is a local AI coding workspace. Installation should provide two
equal entry points: `lightcode` for the terminal UI and `lightcode web` for a
localhost browser UI. Both surfaces share projects, sessions, settings,
permissions, and complete conversation history.

## Positioning

One server-authoritative local agent engine supports both terminal-native and
browser-native workflows without uploading workspace browsing or session state
to a separate Lightcode cloud service.

## Operating Context

Users install Lightcode from npm and launch it from a terminal. The browser
surface opens on a loopback address and uses the host folder chooser first: the
Windows and macOS system dialogs, then Zenity or KDialog on Linux when one is
available in a graphical session. If the system chooser is unavailable or
cannot open—including Linux without Zenity or KDialog—the authenticated in-app
browser falls back to Home, Desktop, Documents, Downloads, and Projects as
explicitly opened locations. This bounded fallback is also available as a
secondary action. The local server alone receives and
canonicalizes the selected path, rejects filesystem roots, and grants the
chosen project; the browser never submits an arbitrary host path. Provider
calls still use the provider configured by the user.

## Capabilities and Constraints

- Preserve the current terminal UI and add the browser as `lightcode web`.
- Reuse existing streaming chat, durable runs, resume, abort, approvals,
  undo/redo, context, model, mode, and session APIs.
- The first browser release covers project selection, session history, chat,
  tool activity and approvals, mode/permission controls, and provider readiness.
- Project selection is native-first. Cancelling the host dialog leaves the
  current workspace unchanged; an unavailable or failed chooser falls back to
  the bounded common-location browser with retry when appropriate. Users can
  also open that bounded browser directly as a secondary action.
- Provider connection, model selection, and deeper diagnostics remain in the
  terminal for this release and can move into the browser incrementally.
- Agents, Skills, MCP, Plugins, and deeper customization remain accessible from
  the terminal initially and can become browser surfaces incrementally.
- Browser code never supplies unrestricted arbitrary-path input. Native chooser
  results are received and canonicalized server-side; the common-location
  fallback is capability-bounded, and filesystem roots and symlink escapes
  remain rejected.
- The server remains loopback-only by default. A browser UI requires strict
  Host/Origin validation and per-launch authorization; localhost alone is not
  treated as authentication.
- Full local conversation history remains authoritative in SQLite.

## Brand Commitments

The product name is Lightcode. The browser should feel like the same precise,
quiet coding instrument as the terminal client, while using familiar desktop
workspace navigation. The supplied desktop coding-workspace screenshot is an
information-architecture reference, not a request to copy another product's
branding.

## Evidence on Hand

- Existing OpenTUI client and theme under `apps/cli/src`.
- Existing Hono session and agent APIs under `apps/server/src`.
- Existing shared React chat state under `packages/ai/src/react`.
- User-provided desktop workspace screenshot showing session navigation,
  project context, a large chat canvas, and compact mode/model controls.

## Product Principles

- One local engine, two first-class interfaces.
- Project choice is obvious, reversible, and separate from write authority.
- Show agent progress and approvals without overwhelming the conversation.
- Preserve continuity: a session started in one interface opens correctly in
  the other.
- Default to bounded access and explain operating-system permission failures in
  plain language.
