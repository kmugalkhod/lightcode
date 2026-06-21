# `apps/cli` — OpenTUI Architecture Explainer

This document explains how the Lightcode terminal UI (`apps/cli`) is built and
how its pieces fit together. It is a reading guide for the source, not a user
manual — for usage see the top-level `README.md`.

## 1. Role and tech stack

`apps/cli` is the interactive front end of Lightcode: a terminal user interface
built with [OpenTUI](https://github.com/sst/opentui) (`@opentui/core` +
`@opentui/react`). It renders a chat-style coding agent UI, drives the local
Hono API server (`apps/server`), and talks to the AI runtime in
`packages/ai`.

Key dependencies (see `apps/cli/package.json`):

| Dependency        | Role                                                                 |
| ----------------- | ------------------------------------------------------------------- |
| `@opentui/core`   | The renderer: creates the terminal surface, handles input/selection |
| `@opentui/react`  | React reconciler over OpenTUI (`createRoot`, `useKeyboard`, `box`, `text`, `input`, `scrollbox`) |
| `react` (`^19`)   | UI component model                                                  |
| `react-router` (`^7`) | In-app navigation via `MemoryRouter`                            |
| `hono`            | Type-safe RPC client (`hono/client`) against the server's `AppType` |
| `@lightcode/ai`   | The agent runtime, tool suite, permission engine, and the `useCodingSessionChat` React hook |
| `@lightcode/shared` | Shared constants (`productName`, `lightcodeVersion`)              |
| `zod`             | Runtime validation of server/route payloads                         |

The package declares a `bin` (`lightcode` → `./src/index.tsx`) and is run under
Bun (`bun src/index.tsx`); the entry file carries a `#!/usr/bin/env bun`
shebang.

## 2. Bootstrap sequence

Entry point: `apps/cli/src/index.tsx`. The startup order is deliberate and
worth understanding:

1. **Handle `--version` early** — prints `Lightcode v<version>` and exits
   before touching the network or renderer.
2. **Ensure a server is reachable** — `ensureServerRunning()` from
   `lib/server-launcher.ts` (described in §8).
3. **Create the OpenTUI renderer** with `exitOnCtrlC: false`. The app owns
   Ctrl+C itself (copy selection / "press again to exit"), so the renderer must
   not hard-quit on it. Ctrl+Q remains an immediate quit.
4. **Register teardown** for the CLI-owned server process (if one was spawned)
   on `exit`, `SIGINT`, and `SIGTERM`. The server also has a
   `LIGHTCODE_PARENT_PID` parent-death watchdog as a backstop for SIGKILL /
   terminal close.
5. **Mount React** — `createRoot(renderer).render(<App />)`.

## 3. Directory layout

```
apps/cli/src/
├── index.tsx                  # Entry: version flag, server launch, renderer, React root
├── app.tsx                    # App shell: router, header, footer, global key handling, overlays
├── state/app-state.tsx        # AppStateProvider — global UI flags (palettes, toggles, chat actions)
├── navigation/
│   ├── route-registry.ts      # Canonical list of routes + slash-page matching helpers
│   └── route-state.ts         # zod schema for location.state passed into a chat session
├── screens/                   # Route-level containers
│   ├── chat-screen.tsx        # The main agent conversation screen (largest file)
│   ├── home-screen.tsx        # Landing/prompt entry
│   ├── onboarding-screen.tsx  # First-run provider/key setup
│   ├── session-list-screen.tsx
│   ├── model-screen.tsx       # Model info
│   ├── model-select-screen.tsx
│   └── diagnostics-screen.tsx # Reused for /status /doctor /permissions /tools /config
├── components/
│   ├── help-overlay.tsx
│   ├── home-text-area.tsx
│   ├── home-ascii-art.tsx
│   ├── server-status.tsx
│   └── chat/                  # All chat-transcript pieces
│       ├── chat-shell.tsx              # Transcript frame + scrollbox + empty state
│       ├── chat-message.tsx            # One message: maps UIMessage parts → part components
│       ├── chat-message-text-part.tsx
│       ├── chat-message-reasoning-part.tsx
│       ├── chat-message-tool-invocation-part.tsx
│       ├── chat-message-error-part.tsx
│       ├── chat-text-area.tsx          # Prompt input (@mentions, paste, slash sync)
│       ├── chat-tool-approval-card.tsx
│       ├── chat-proposed-plan-card.tsx
│       ├── chat-todo-status-card.tsx
│       ├── chat-context-summary-card.tsx
│       ├── chat-diff-card.tsx
│       ├── chat-interaction-popup.tsx
│       ├── model-selector.tsx
│       ├── permission-mode-selector.tsx
│       ├── copy-mode-overlay.tsx
│       └── loading-timer.tsx
├── commands/                  # Command surfaces (palette + slash menus)
│   ├── command-registry.ts    # Builds the command list from routes + keymap
│   ├── command-palette.tsx    # Ctrl+P palette overlay
│   ├── keymap.ts              # Global key bindings → actions
│   ├── slash-menu-items.ts    # Merges nav routes + chat actions for the "/" menu
│   ├── slash-page-menu.tsx    # The "/" page menu overlay
│   ├── chat-slash-actions.ts  # In-session slash actions (/compact /copy /undo ...)
│   └── export-session-markdown.ts
├── hooks/                     # Small reusable React hooks
│   ├── use-config-badge.ts
│   ├── use-context-window.ts
│   ├── use-loading-timer.ts
│   └── use-auto-continue-config.ts
├── lib/
│   ├── api-base-url.ts        # Resolves the server URL (127.0.0.1:4983 by default)
│   ├── client.ts              # Hono RPC client (typed against AppType)
│   ├── server-launcher.ts     # Health-check + spawn-or-reuse the server
│   └── clipboard.ts           # Cross-platform clipboard copy
├── ui/
│   ├── cli-theme.ts           # Central color/theme tokens
│   ├── cli-theme-capabilities.ts # Glyph/feature detection per terminal
│   ├── code-syntax-style.ts
│   └── components/            # badge, status-dot; hooks/use-spinner
└── utils/                     # Pure helpers
    ├── file-mentions.ts       # @file mention → attachment
    ├── paste-placeholders.ts  # Collapse long pastes to [Pasted text #n +k lines]
    ├── clipboard-image.ts     # Read PNG from macOS clipboard (silent-degrade on non-darwin)
    ├── image-attachments.ts   # [Image #n] chip ↔ FileUIPart for vision
    ├── chat-context-utils.ts  # Context-window helpers for the context cards
    ├── fuzzy-match.ts
    ├── markdown-code.ts
    ├── key-utils.ts
    └── text-utils.ts
```

Filenames are kebab-case throughout (including `.tsx`), per `AGENTS.md`.
Screen-level containers live under `screens/`; reusable UI under `components/`
and `ui/components/`.

## 4. The app shell — `app.tsx`

`App` wraps everything in `MemoryRouter` (initial entry `/`) and
`AppStateProvider`. The real shell is `AppContent`, which is a single full-height
`box` column with three bands:

1. **Header** — `StatusDot` + "Lightcode" + provider/model badge (from
   `useConfigBadge`) + the current view label.
2. **Body** — a `position="relative"` padded box holding `<Routes>` plus the
   overlay layer (command palette, slash page menu, help overlay). Overlays are
   absolutely positioned `<box>`es with increasing `zIndex` (palette/slash 20,
   help 30) so they stack above screens.
3. **Footer** — contextual status line: slash-menu hints, or
   `Esc/Ctrl+G Back | / Pages | Ctrl+P Cmd | F1 Help | Ctrl+C Quit`, overridden
   by the transient Ctrl+C notice.

### Global key handling

`AppContent` installs one `useKeyboard` listener that is the single source of
truth for global keys. Order of precedence:

1. **Ctrl+C** — always first. `handleCtrlC()` copies any active renderer
   selection; if none, it arms a 2-second "press again to exit" window and
   quits on the second press (`renderer.destroy()`).
2. **Slash menu** open → `handleSlashMenuKeyDown` (Up/Down/Enter/Esc/Backspace).
3. **Command palette** open → `handlePaletteKeyDown`.
4. Otherwise normalize the key and look it up in `keymap.ts`; the matched
   `action` string is dispatched via `handleAction`.

`handleAction` resolves `nav:*` actions to `navigate(path)`, and handles
`system:quit`, `system:palette`, `system:slashPalette`, `system:back`,
`system:help`, `system:toggleToolOutput` (Ctrl+O), `system:toggleReasoning`
(Ctrl+R), and `system:cancel`.

> Note on Ctrl+C: because the renderer is created with `exitOnCtrlC: false`,
> nothing quits on a single Ctrl+C. This is intentional — see the comment in
> `index.tsx` and `app.tsx`.

### Onboarding gate

`needsOnboarding` is true when the config badge is `available` but credential
hints are non-empty; an effect then redirects to `/onboarding`. This is why a
fresh install lands on the provider setup screen automatically.

## 5. Global UI state — `state/app-state.tsx`

A single React context (`AppStateProvider` / `useAppState`) holds cross-screen
UI flags:

- **Command palette**: `paletteOpen`, `paletteQuery`, `paletteSelected`,
  `openPalette`/`closePalette`.
- **Slash page menu**: `slashMenuOpen`, `slashMenuQuery`, `slashMenuSelected`,
  `openSlashMenu`/`closeSlashMenu`.
- **Chat action bridge**: `requestedChatActionId` /
  `requestChatAction` / `clearRequestedChatAction`. The global key handler owns
  slash-menu selection, but only the chat screen has session context to execute
  a chat action — so it watches `requestedChatActionId` and clears it after
  running.
- **Config refresh nonce** — bumped after onboarding writes config so consumers
  refetch.
- **Global toggles**: `expandedToolOutput` (Ctrl+O) and `expandedReasoning`
  (Ctrl+R).

Navigation itself is not in here — that stays with `react-router`'s
`useNavigate`/`useLocation`.

## 6. Navigation — `navigation/route-registry.ts`

A single `routeRegistry` array describes every reachable destination with
`id`, `label`, `description`, `path`, and `shortcut` (the slash token). Routes:
`/`, `/status`, `/doctor`, `/permissions`, `/sessions`, `/sessions/:id`,
`/tools`, `/config`, `/model-info`, `/model`, `/onboarding`, plus a hidden
`/sessions/latest` "Resume Latest".

Helpers:

- `getNavigationRoutes()` — non-hidden routes (drives both the command palette
  and the slash menu).
- `getSlashPageRoutes(query)` — fuzzy filter for the `/`-menu.
- `getPathFromAction(action)` — turns `nav:<id>` command ids into paths.

`route-state.ts` defines `sessionRouteLocationStateSchema` — the typed
`location.state` shape passed when navigating into a chat session
(`input`, `skipHistoryLoad`, `mode`, `permissionMode`). `coerceSessionRouteLocationState`
safely parses unknown state into this shape.

### Diagnostics screen multiplexing — `screens/diagnostics-screen.tsx`

`DiagnosticsScreen` is one component reused for five routes — `/status`,
`/doctor`, `/permissions`, `/tools`, and `/config`. Each `<Route>` in `app.tsx`
mounts it with a hard-coded `kind` prop
(`<DiagnosticsScreen kind="status" />`, etc.); `kind` is a
`DiagnosticsScreenKind` union (`"status" | "doctor" | "permissions" | "tools" |
"config"`) and selects everything else: the page title (`pageTitles[kind]`),
the endpoint hit in `loadDiagnostics` (`client.diagnostics.<kind>.$get()`), the
zod schema that parses the response (`diagnosticsStatusResponseSchema`, …), and
the `render<Kind>` function that draws the panel. So adding a sixth diagnostics
page means a new `kind` literal plus a matching route, endpoint, schema, and
renderer — not a new screen.

## 7. Command system

Three overlapping ways to invoke actions:

### 7a. Keymap — `commands/keymap.ts`

A static `keymap.bindings` map from key sequence → `{ action, label, category }`.
Bindings include `/` (slash palette), `ctrl+p` (palette), `ctrl+g` (back),
`ctrl+c`/`ctrl+q` (quit), `f1`/`ctrl+/` (help), `ctrl+o` (expand tool output),
`ctrl+r` (show reasoning). `normalizeKeyName` produces the canonical
`"ctrl+x"` style key used for lookup. A bare `q` deliberately does **not**
quit (footgun while typing) — only Ctrl+C / Ctrl+Q.

### 7b. Command palette — `commands/command-registry.ts` + `command-palette.tsx`

`command-registry.ts` builds the unified `Command[]` list by merging navigation
routes (as `nav:<id>` commands) with non-navigation keymap bindings.
`searchCommands(query)` filters by label/id/shortcut. The `CommandPalette`
component renders the Ctrl+P overlay: search `<input>`, filtered list with
selection indicator, and a footer hint bar.

### 7c. Slash menus — `slash-menu-items.ts`, `slash-page-menu.tsx`, `chat-slash-actions.ts`

Typing `/` (on Home or in a chat session) opens the **slash page menu**, which
lists navigation routes plus, in a session, in-session chat actions. Outside a
session it is a floating overlay; inside a session the chat text area *hosts*
the menu inline (see `inputHostsSlashMenu` in `app.tsx`), so the global overlay
is suppressed there.

In-session actions are defined in `chat-slash-actions.ts` as
`ChatSlashActionDefinition` entries (`kind: "chat-action"`, `id`, `shortcut`,
`run(context)`). Examples: `/compact` (calls
`client.sessions[":id"].compact.$post` and updates context state), `/undo`
(checkpointed file revert via `@lightcode/ai/runtime`), `/export` (markdown
export via `commands/export-session-markdown.ts`), `/copy`, `/skills`,
`/permission`. Actions are matched on the command
token only so they accept arguments (`/copy all` → the `/copy` action with
`args = "all"`).

When the global key handler selects a chat action from the slash menu, it calls
`requestChatAction(item.id)`; `ChatScreen` observes `requestedChatActionId` and
executes it (this is the bridge in §5).

## 8. Server communication

### Base URL — `lib/api-base-url.ts`

`apiBaseUrl = Bun.env.LIGHTCODE_API_URL ?? "http://127.0.0.1:4983"`. The
explicit `127.0.0.1` (not `localhost`) is intentional: the server binds
loopback IPv4 only, while `localhost` can resolve to `::1` and let another
user dev server bound to `[::]` intercept traffic.

### Typed client — `lib/client.ts`

```ts
import { hc } from "hono/client";
import type { AppType } from "@lightcode/server/rpc";
export const client = hc<AppType>(apiBaseUrl);
```

Every server call in the CLI goes through this single `client`, so request
paths, params, and JSON bodies are type-checked against the server's Hono
routes (e.g. `client.sessions[":id"].compact.$post({ param: { id } })`). All
responses are additionally validated with zod schemas imported from
`@lightcode/ai` (e.g. `sessionMessagesResponseSchema`,
`sessionContextResponseSchema`, `sessionCompactResponseSchema`).

### Server lifecycle — `lib/server-launcher.ts`

`ensureServerRunning()` runs before the renderer starts:

1. `checkServer(url)` GETs `/config/status` and classifies the port as
   `healthy` (JSON with `selectedProvider`), `foreign` (something else
   responding), or `down`.
2. If **healthy**: reuse it, `ownedProcess = null`.
3. If **foreign**: return a fatal error telling the user to free the port or
   set `LIGHTCODE_API_URL` / `PORT`.
4. If **down**: `resolveServerEntry()` finds the server entry (published
   `dist/server.js` next to `dist/cli.js`, or the monorepo
   `apps/server/src/index.ts`), spawns it as a Bun child process with stdout/
   stderr redirected to `~/.lightcode/logs/server.log`, sets
   `LIGHTCODE_PARENT_PID` so the server self-exits if the CLI dies, then polls
   `/config/status` until healthy (or the child exits with an error).

`restartOwnedServer()` kills and respawns the owned process (used after
onboarding writes new credentials) and returns `false` if this CLI doesn't own
the server.

## 9. The chat architecture

This is the core of the app. The layers, from bottom to top:

### 9a. `useCodingSessionChat` — `packages/ai/src/react/use-coding-session-chat.ts`

The real engine. It wraps the AI SDK's `useChat` (`@ai-sdk/react`) with a
`DefaultChatTransport` pointed at the server's streaming chat endpoint, and
adds Lightcode-specific behavior:

- Loads persisted session messages and pending interactions on mount.
- Maintains `UIMessage[]` and renders incrementally (throttled at
  `chatMessageUpdateThrottleMs = 50`).
- Evaluates **tool permissions** via `evaluateCodingToolPermission` /
  `resolveCodingPermissionMode`; tools needing approval surface as
  `PendingToolApproval[]` with `toolCallId`, `summary`, and
  `permissionDecision`.
- Runs an **auto-continue** loop (`decideAutoContinue`, `shouldTreatAsStalled`)
  to keep the agent working across multi-step tasks without user nudges.
- Detects leaked textual tool-call XML (`TOOL_CALL_XML_RE`) and recoverable
  disconnects, exposing typed `ChatErrorKind`s.
- Bridges **chat interactions** (server-persisted prompts/plan confirmations)
  via `ChatInteractionUpsertRequest` / `ChatInteractionResolveRequest`.

`ChatScreen` consumes this hook and maps its state into React components.

### 9b. `ChatScreen` — `screens/chat-screen.tsx` (the largest screen)

Responsibilities:

- Parse the `:id` route param and `location.state` (initial prompt, mode,
  permission mode, `skipHistoryLoad`).
- Load persisted messages, context state, and pending interactions via the
  typed `client`.
- Sync the slash menu with the text area (`syncSlashMenuFromInput`): typing
  `/...` on the first line opens/closes and filters the slash menu.
- Watch `requestedChatActionId` from `AppState` and execute the corresponding
  `chatSlashAction` (§7c), then clear it.
- Render the transcript via `ChatShell` + a list of `ChatMessage`s, plus
  auxiliary cards:
  - `ChatContextStateCard` / `ChatContextSummaryCard` — context-window usage
    and compaction summaries (helpers in `utils/chat-context-utils.ts`).
  - `ChatToolApprovalCard` — pending tool approvals (approve/deny, with
    "all" targeting).
  - `ChatProposedPlanCard` — proposed-plan blocks; "yes/ok/..." keywords
    (`planConfirmationAcceptKeywords`) trigger implementation,
    "no/revise/..." (`planConfirmationReviseKeywords`) trigger revision.
  - `ChatTodoStatusCard` — live todo list state from the agent's `todo_write`.
  - `ChatInteractionPopup` — server-driven plan/clarification prompts.
- Handle plan-confirmation flow: `shouldImplementApprovedPlan`,
  `autoImplementationInstruction`, `defaultPlanRevisionRequest`,
  `defaultPromptDismissResponse`.
- `ModelSelector` (`components/chat/model-selector.tsx`) — overlay listing
  available models (with context length and tool/reasoning support) and switching
  the session's active model.
- `PermissionModeSelector` (`components/chat/permission-mode-selector.tsx`) —
  overlay for choosing the session's permission mode (read-only,
  workspace-write, …), shown with each mode's risks.
- `LoadingTimer` (`components/chat/loading-timer.tsx`, driven by
  `useLoadingTimer`) — inline "Thinking 0:05" indicator with a spinner and an
  optional output-token count, shown while the assistant is working.
- Auto-continue config (`useAutoContinueConfig`), context-window hook
  (`useContextWindow`), and copy mode (`CopyModeOverlay`).

### 9c. The transcript — `components/chat/`

- **`chat-shell.tsx`** — the framed transcript: a header (title + message
  count), a `scrollbox` with `stickyScroll`/`stickyStart="bottom"` so new
  content auto-scrolls, an empty state ("◆ ready"), an optional error strip,
  and the `inputArea` slot.
- **`chat-message.tsx`** — renders one `UIMessage`. It maps each
  `message.parts` entry to a part component:
  - `text` → `ChatMessageTextPart`
  - `reasoning` → `ChatMessageReasoningPart`
  - tool UI part (`isToolUIPart`) → `ChatMessageToolInvocationPart`
  - `step-start` → skipped
  - unknown → `ChatMessageErrorPart`

  The whole message sits in an immersive `box` with a role-tinted background
  and a solid left border (`getMessageRoleTheme`), prefixed by a role glyph
  (`ROLE_GLYPHS` from `cli-theme-capabilities`).
- **`chat-message-tool-invocation-part.tsx`** — renders tool calls across their
  lifecycle states (`input-streaming`, `input-available`, `approval-requested`,
  `approval-responded`, `output-available`, `output-error`, `output-denied`),
  respecting the global `expandedToolOutput` toggle (Ctrl+O) and diff rendering
  for file-edit tools (`ChatDiffCard`).

### 9d. Input — `components/chat/chat-text-area.tsx`

The prompt box. It handles `@file` mentions (`utils/file-mentions.ts` →
`appendMentionAttachments`), image pasting/attachments
(`utils/clipboard-image.ts`, `utils/image-attachments.ts`,
`utils/paste-placeholders.ts`), and keeps the slash-menu query in sync with the
first line of input via the callback from `ChatScreen`.

The paste/attachment path has three sub-flows, each isolated in a pure,
unit-tested helper so the textarea itself stays free of side effects:

- **Paste → placeholder → submit-splice** (`utils/paste-placeholders.ts`): a
  paste is collapsed to a short `[Pasted text #<n> +<k> lines]` marker when it
  exceeds `PASTE_PLACEHOLDER_LINE_THRESHOLD` (5 lines) or
  `PASTE_PLACEHOLDER_CHAR_THRESHOLD` (400 chars), keeping the textarea readable.
  The full text is held in a per-index store and spliced back in at submit time
  by `expandPastePlaceholders`, which only replaces intact markers — a marker the
  user edited or deleted no longer matches the `PASTE_PLACEHOLDER_PATTERN`, so an
  intentional removal is never reintroduced.
- **macOS clipboard-image recovery** (`utils/clipboard-image.ts`): terminals
  deliver only text through bracketed paste, so a pasted screenshot arrives as an
  empty paste. `readClipboardImage()` recovers the real bytes on darwin by asking
  AppleScript for the clipboard's `«class PNGf»`, returning a
  `ClipboardImage { mediaType: "image/png", base64, byteLength }`. It returns
  `null` on non-darwin, when the clipboard holds no image, or on any failure, and
  never throws — pasting must degrade silently to plain text rather than break the
  input.
- **`[Image #<n>]` chip ↔ `FileUIPart`** (`utils/image-attachments.ts`): a
  recovered image is shown in the box as a compact `formatImageChip(n)` →
  `[Image #<n>]` marker while the bytes ride along separately. At submit time
  `clipboardImageToFilePart` builds an AI-SDK `FileUIPart`
  (`{ type: "file", mediaType, filename: "pasted-image-<n>.png",
  url: "data:<mediaType>;base64,..." }`) for the vision model, and
  `stripImageChips` removes the now-redundant chip from the text the model
  receives (collapsing the double spaces a removed chip can leave behind).

## 10. Theming — `ui/cli-theme.ts`

A single `CliTheme` object centralizes all color tokens: `surfaces`
(base/panel/elevated/inset), `borders`, `text`, `accent`, `semantic`
(success/warning/error/info), `diff` (added/removed fg+bg), `messageRoles`
(per-role label/border/background/glyph), `scroll`, and `overlay`. Components
never hardcode colors — they read `cliTheme.*`. `cli-theme-capabilities.ts`
detects terminal features (e.g. whether box-drawing/glyphs are safe) and
exposes `activeGlyphs` used for role icons. `borderStyleFor` maps contexts
(card/modal/chrome) to OpenTUI border styles.

## 11. Key end-to-end flows

### Startup

```
index.tsx
  → --version? exit
  → ensureServerRunning()        (reuse / spawn / error)
  → createCliRenderer({ exitOnCtrlC: false })
  → register SIGINT/SIGTERM/exit cleanup for owned server
  → createRoot(renderer).render(<App />)
       → MemoryRouter + AppStateProvider + AppContent
            → needsOnboarding? navigate("/onboarding")
            → else render HomeScreen at "/"
```

### Sending a message

```
ChatScreen (route /sessions/:id)
  → ChatTextArea captures prompt (+ @mentions, images, /commands)
  → Enter → useCodingSessionChat.sendMessage(...)
       → server /sessions/:id/chat stream (via DefaultChatTransport)
       → streaming UIMessage parts update the transcript (throttled)
       → tool calls → evaluateCodingToolPermission
            → auto-allowed: execute via runtime-registry
            → needs approval: PendingToolApproval → ChatToolApprovalCard
       → auto-continue loop continues until done/stalled
```

### Tool approval

```
PendingToolApproval surfaced → ChatToolApprovalCard
  → user approves/denies (or "all")
  → useCodingSessionChat resolves the tool call (approve | deny)
  → ChatMessageToolInvocationPart transitions approval-requested → approval-responded → output-*
```

### Context compaction (`/compact`)

```
slash menu → requestChatAction("compact") → ChatScreen runs runCompactAction
  → client.sessions[":id"].compact.$post
  → validate sessionCompactResponseSchema → setContextState(...)
  → ChatContextSummaryCard updates; history is preserved (tiered context lives in packages/ai)
```

## 12. Where to look next

- **Agent runtime, tools, permissions, context tiering**:
  `packages/ai/src/` (esp. `coding-agent.ts`, `agent-tools/`, `permissions/`,
  `context/`, `react/use-coding-session-chat.ts`).
- **API routes and persistence**: `apps/server/src/` (Hono app, `chat-stream.ts`,
  `workspace-context.ts`).
- **Product/epic context**: `docs/epics/` and `AGENTS.md`.
- **Shared constants**: `packages/shared`.
