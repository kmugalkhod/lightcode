# Feature Plan — Right-Side "Live Changes" File Explorer

## Goal
Add a **collapsible**, professional right-side panel to the chat screen that
lists every file the agent touches and lets the user select a file to see the
actual diff (what changed in the code), updating live as the agent streams
edits. The panel can be toggled open/closed **two ways**: a **keystroke** and a
**clickable icon** (click toggles open ↔ closed). It must look polished and fit
the existing visual language.

## Architecture facts (grounding)
- **Framework**: OpenTUI (`@opentui/core` / `@opentui/react`) + React 19. Layout
  via flexbox `<box>`; native `<diff>` and `<scrollbox>` elements exist.
- **Main layout**: `apps/cli/src/screens/chat-screen.tsx:888` renders a single
  `<box width="100%" height="100%">` wrapping `<ChatShell>`. This is the split
  point.
- **Shell**: `apps/cli/src/components/chat/chat-shell.tsx` — vertical column
  (title + scrollbox of messages + input). Today it is full width.
- **Edit source of truth**: tool parts on messages. `getFileEditDiff()` at
  `chat-message-tool-invocation-part.tsx:83-100` reads `{ path, diff }` from a
  tool part when `part.state === "output-available"`. Same shape we reuse for
  the panel.
- **Messages stream**: `messages` array from `useCodingSessionChat()` (wraps
  `@ai-sdk/react` `useChat`). `chat-screen.tsx:964` already maps over it. Tool
  parts have streaming states incl. `input-streaming` and `output-available`.
- **Diff rendering already solved**: `ChatDiffCard`
  (`chat-diff-card.tsx`) wraps native `<diff>` with theme colors + filetype
  inference. Reuse it inside the panel.
- **Theme**: `apps/cli/src/ui/cli-theme.ts` — `cliTheme.surfaces.*`,
  `cliTheme.diff.*`, `cliTheme.borders.*`, `typeRole()`, `space`, `borderStyleFor`.
- **Keyboard**: global handler `app.tsx:295-330` via `useKeyboard`; bindings in
  `commands/keymap.ts`. Chat-screen has its own `useKeyboard` block (~795-885)
  with a focus/"copy mode" pattern to copy from.
- **Mouse**: OpenTUI exposes `onMouseDown` / `onMouse` / `onMouseOver` /
  `onMouseOut` on every element (`@opentui/core/Renderable.d.ts:76-85`). The app
  uses **zero** mouse handlers today, so Phase 1 must first confirm mouse
  reporting is enabled on the renderer (`useRenderer()` in `app.tsx`) and enable
  it if not. This is the prerequisite for the clickable icon.

---

## Phase 0 — Changed-files data hook (no UI)
**Outcome:** a single source of truth for "what files changed".

- Create `apps/cli/src/components/chat/use-changed-files.ts`.
- Input: the `messages` array. Walk every message's tool parts, reuse the
  `getFileEditDiff()` logic (export it from
  `chat-message-tool-invocation-part.tsx` instead of duplicating).
- Output: ordered `ChangedFile[]` = `{ path, diff, addedLines, removedLines,
  lastToolPartId, status: "streaming" | "done" }`. Dedupe by path keeping the
  latest diff; preserve first-touched order.
- Also surface in-flight edits: when a tool part is `input-streaming` /
  `input-available` for an Edit/Write tool, include the file with
  `status: "streaming"` (path may come from input args before output lands).
- Unit-test the reducer with a few synthetic `messages` fixtures.

**Acceptance:** hook returns correct list/order/counts for a fixture
conversation. No visual change yet.

---

## Phase 1 — Layout split + collapse mechanics (keystroke + clickable icon)
**Outcome:** the screen can collapse/expand a right column, driven by BOTH a
keystroke and a clickable icon; hidden by default.

- **Single source of truth:** add `panelOpen` state (default `false`) on the
  chat screen — both toggles flip the same boolean, so keystroke and icon stay
  in sync. Width `~40%`, min ~36 cols.
- **Layout:** in `chat-screen.tsx:888`, change the outer box to
  `flexDirection="row"`. Left child = existing `<ChatShell>` wrapped so it keeps
  `flexGrow`. Right child = `<FileExplorerPanel>`, rendered only when
  `panelOpen`. When collapsed, the chat reclaims full width.
- **Keystroke toggle:** use **`F2`** (verified conflict-free — see Keystroke
  verification below). Add it to `keymap.ts` as a new binding
  (`f2 → system:toggleChangesPanel`, mirroring the `f1` help entry) and handle
  it via `setPanelOpen(o => !o)`. Document it in the help overlay next to F1.
- **Clickable icon toggle:** add a small always-visible affordance — an icon
  button (e.g. `▐ ◧ Changes`) in the chat header/top-right via a new
  `PanelToggleButton` component. Wire `onMouseDown` to the SAME
  `setPanelOpen(o => !o)`. Clicking it once opens, clicking again closes.
  - The icon reflects state: e.g. `◧` (open) vs `◨`/`▢` (closed), plus a badge
    with the changed-file count from `useChangedFiles`.
  - Add `onMouseOver`/`onMouseOut` hover styling so it reads as interactive.
  - First confirm mouse reporting is enabled (see Architecture → Mouse); enable
    on the renderer if needed.
- **Optional in-panel close:** a clickable `✕` in the panel header (also
  `onMouseDown → setPanelOpen(false)`) for an obvious close target.
- **Small terminals:** below a width threshold, force the panel hidden and make
  both toggles no-ops (avoid breaking layout).

**Acceptance:** the icon and the keystroke both open AND close the panel and
agree on state; clicking the icon twice returns to the start; chat scroll and
input focus are undisturbed throughout.

### Keystroke verification (done — use F2, NOT Ctrl+E)
The chat input is OpenTUI's native `<textarea>`, which consumes a fixed set of
ctrl keys **while focused** (i.e. during normal typing). Verified against
`node_modules/@opentui/core/index.js` default textarea keybindings:
- **Taken by the textarea:** `ctrl+a` (line-home), `ctrl+b` (move-left),
  `ctrl+d` (delete), `ctrl+e` (**line-end** — this is why Ctrl+E is unusable),
  `ctrl+f` (move-right), `ctrl+k` (delete-to-line-end), `ctrl+u`
  (delete-to-line-start), `ctrl+w` (delete-word-back), plus ctrl+backspace/
  delete/left/right.
- **Taken elsewhere:** `keymap.ts` → ctrl+p, ctrl+g, ctrl+c, ctrl+q, ctrl+o,
  ctrl+r, ctrl+/, f1; chat-screen direct → ctrl+y, ctrl+t, Tab; input custom →
  ctrl+v, ctrl+Enter.
- The app's existing `Ctrl+O` / `Ctrl+R` toggles work precisely because the
  textarea does not claim them — follow that pattern.
- **Decision: `F2`.** Conflict-free, not consumed by the textarea, and mirrors
  the existing `F1 = Help` convention. (Runner-up safe keys if ever needed:
  `Ctrl+L`, `Ctrl+N`. Avoid ctrl+h/i/j/m = control-code aliases, ctrl+s =
  terminal flow-control freeze, ctrl+z = suspend.)

---

## Phase 2 — File list view
**Outcome:** the panel lists changed files with stats.

- Create `apps/cli/src/components/chat/file-explorer-panel.tsx`. Consume
  `useChangedFiles(messages)`.
- Render a header ("Changes · N files") + a `<scrollbox>` list. Each row:
  basename (bold) + dim dir path, right-aligned `+adds`/`-dels` using
  `cliTheme.diff.*`, and a spinner/indicator for `status: "streaming"`.
- Empty state: "No file changes yet." using `typeRole("secondary")`.
- Style with `cliTheme.surfaces.inset`, `borderStyleFor.card`,
  `cliTheme.borders.default` to match `ChatShell`.

**Acceptance:** every agent edit appears as a row with correct +/- counts;
order stable; matches existing visual language.

---

## Phase 3 — Diff detail view
**Outcome:** selecting a file shows its full diff in the panel.

- Add `selectedPath` state to the panel. Default to the most recently changed
  file.
- Below (or replacing) the list, render `ChatDiffCard` for the selected file —
  reuse the existing component; do not re-implement diff rendering. Use its
  full (non-collapsed) mode so the panel is the "deep look".
- Split panel vertically: top = file list (capped height, scrolls), bottom =
  diff for selection (scrolls independently).

**Acceptance:** clicking/selecting a file renders its real diff with syntax
highlighting + line numbers; switching files updates instantly.

---

## Phase 4 — Live streaming behavior
**Outcome:** panel reflects edits as they happen.

- When a new file edit completes, auto-select it (unless the user has manually
  selected another file — track a "user pinned selection" flag).
- Show `streaming` rows with a live indicator; when the tool part flips to
  `output-available`, swap to the final diff + stats.
- Keep the list auto-scrolled to the newest change (sticky-bottom like the chat
  scrollbox) unless the user scrolled up.

**Acceptance:** during a multi-file agent turn, the panel updates row-by-row in
real time and lands on the final diffs.

---

## Phase 5 — Keyboard navigation & focus
**Outcome:** the panel is usable without a mouse.

- Reuse the chat-screen focus pattern (the "copy mode" gating at ~795-885).
  Introduce panel focus: when focused, `↑/↓` move selection, `Enter` opens diff,
  `Tab`/`Esc` returns focus to the input, `Ctrl+E` still toggles visibility.
- While the panel is focused, stop those keys from reaching the text area
  (`stopPropagation`), mirroring how slash/palette menus gate keys.
- Update the input footer hint + help overlay with the new shortcuts.

**Acceptance:** user can open the panel, arrow through files, view diffs, and
return to typing — all from the keyboard.

---

## Phase 5.5 — Professional visual design
**Outcome:** the panel and its toggle look polished and intentional, not bolted
on. Treat this as a first-class pass, not an afterthought.

- **Consistency:** reuse `borderStyleFor.card`, `cliTheme.surfaces.inset`,
  `cliTheme.borders.default`, `typeRole()`, and `space.*` so the panel is
  visually a sibling of `ChatShell` — same border weight, padding rhythm, and
  type scale.
- **Clear hierarchy:** panel header (title + count + close `✕`) → file list →
  diff. Use `typeRole("section")`/`label`/`secondary`/`caption` for the tiers.
- **Toggle affordance:** the icon button should read as a control — subtle
  border/background, hover state, accent color when the panel is open, muted
  when closed. Show the change count as a small badge (reuse the `Badge`
  component already used in the input footer).
- **Selected/active states:** the selected file row gets an accent left-edge or
  background (`cliTheme.surfaces.elevated`), the rest muted. Streaming rows get
  a tasteful animated indicator, not a noisy one.
- **Diff stats:** align `+adds`/`-dels` to a right column using `cliTheme.diff.*`
  greens/reds; truncate long paths from the left so the basename stays visible.
- **Transitions:** opening/closing should feel instant and stable — no layout
  jitter; the chat column resizes cleanly.
- **Reduced clutter:** spacing and dividers over heavy borders inside the panel;
  one clear focal point at a time.

**Acceptance:** a design-review look shows the panel matches the app's existing
polish, the toggle clearly reads as clickable, and states (open/closed,
selected, streaming) are visually unambiguous.

---

## Phase 6 — Polish & edge cases
- **Responsiveness**: recompute panel width on terminal resize; hide under the
  min-width threshold.
- **Large diffs**: cap rendered lines in the panel diff with a "+N more" footer
  (ChatDiffCard already collapses — pick the right mode).
- **Deletes/renames/creates**: ensure status labels read correctly (created vs
  modified vs deleted) from the diff/tool output.
- **Persistence (optional)**: remember `panelOpen` across sessions via existing
  config/app-state plumbing.
- **Theming pass**: verify against all themes in `cli-theme.ts`.

**Acceptance:** no layout breakage on resize, large diffs perform, all change
types labeled correctly.

---

## Suggested order for `/goal`
0 → 1 → 2 → 3 → 4 → 5 → 5.5 → 6. Phases 0–3 deliver a usable MVP (collapse via
keystroke **and** clickable icon, file list, diffs); 4–5.5 add live updates,
keyboard-first UX, and the professional visual pass; 6 handles edge cases. Each
phase is independently shippable and testable.

## Key files to touch
- `apps/cli/src/screens/chat-screen.tsx` (layout split, `panelOpen` state, both toggles, focus)
- `apps/cli/src/components/chat/file-explorer-panel.tsx` (new — panel)
- `apps/cli/src/components/chat/panel-toggle-button.tsx` (new — clickable icon)
- `apps/cli/src/components/chat/use-changed-files.ts` (new — data hook)
- `apps/cli/src/components/chat/chat-message-tool-invocation-part.tsx` (export `getFileEditDiff`)
- `apps/cli/src/components/chat/chat-diff-card.tsx` (reuse, maybe a "full" mode prop)
- `apps/cli/src/commands/keymap.ts` (new binding)
- `apps/cli/src/app.tsx` (confirm/enable mouse reporting on the renderer)
- `apps/cli/src/components/help-overlay.tsx` (document shortcut)
- `apps/cli/src/ui/cli-theme.ts` (reuse; add tokens only if needed)
