# `apps/cli` Architecture Doc — Improvements (Prioritized)

Findings from comparing `docs/cli-architecture.md` against the current
`apps/cli/src` source tree. Each item lists the gap, the evidence (real file),
and a concrete edit to make.

Priority: **P0** = doc contradicts or omits something a reader would trip on
today; **P1** = material feature under-documented; **P2** = polish / structure.

---

## P0 — New paste/image pipeline is entirely undocumented

The branch adds a paste + clipboard-image subsystem that the explainer does not
mention anywhere. These files exist in `apps/cli/src/utils/` and are wired into
the chat input:

- `utils/paste-placeholders.ts` — collapses long pastes to
  `[Pasted text #<n> +<k> lines]` (thresholds `PASTE_PLACEHOLDER_LINE_THRESHOLD`
  = 5 lines, `...CHAR_THRESHOLD` = 400 chars), splices the full text back at
  submit. Pure helpers, unit-tested by `paste-placeholders.test.ts`.
- `utils/clipboard-image.ts` — `readClipboardImage()` reads a PNG from the
  macOS clipboard via `osascript` (returns `null` on non-darwin, never throws —
  paste degrades silently to text). Exports a `ClipboardImage { mediaType,
  base64, byteLength }`.
- `utils/image-attachments.ts` — renders pasted images as a `[Image #<n>]` chip
  in the textarea while the real bytes ride along as a `FileUIPart`
  (`clipboardImageToFilePart`) for the AI SDK vision path. Pure, tested by
  `image-attachments.test.ts`.

**Why it matters:** This is the headline macOS-paste/onboarding work of the
current branch, and `README.md`'s "macOS (Apple Silicon and Intel)" install
blurb implies it works. A reader following `cli-architecture.md` to understand
the chat input (`§9c` / `chat-text-area.tsx`) finds nothing about how pastes or
pasted screenshots are handled.

**Edit:** Add a new subsection (e.g. `§9d The text area: paste & image input`)
covering: (1) bracketed-paste → collapse-to-placeholder round trip, (2) the
macOS clipboard-image recovery path and its silent-degrade contract, (3) the
`[Image #n]` chip ↔ `FileUIPart` mapping into the AI SDK. Update the `§3`
directory tree to list `utils/clipboard-image.ts`, `paste-placeholders.ts`,
`image-attachments.ts` (and their `.test.ts` twins).

---

## P0 — `chat-message` part list in §9c is incomplete / stale

`§9c` enumerates the `message.parts` → component mapping and stops at
`"... ste"` (truncated). The real `components/chat/` directory has parts the
explainer never names:

- `chat-message-error-part.tsx` — renders error parts (the doc's `§11` flow
  mentions "error strip" in `chat-shell` but not the error *part* component).
- `chat-diff-card.tsx` — a diff card component not mentioned anywhere.

**Edit:** Complete the §9c part-mapping table with `error` →
`ChatMessageErrorPart`, and add `ChatDiffCard` to the "auxiliary cards" list in
`§9b` (where `ChatContextSummaryCard`, `ChatToolApprovalCard`, etc. are listed),
with a one-line description of what a diff card shows.

---

## P1 — Chat-input selectors and hooks are listed only as prose

`§9b` mentions `useAutoContinueConfig`, `useContextWindow`, `useLoadingTimer` /
`LoadingTimer`, and `CopyModeOverlay` inline in a bullet, but several real
selector/hook components have no entry at all:

- `components/chat/model-selector.tsx` (8.8 KB) — model picker UI.
- `components/chat/permission-mode-selector.tsx` (6.9 KB) — permission-mode
  picker UI.
- `components/chat/loading-timer.tsx` — the live loading/elapsed indicator.
- `hooks/use-config-badge.ts`, `hooks/use-context-window.ts`,
  `hooks/use-auto-continue-config.ts`, `hooks/use-loading-timer.ts` — the four
  `hooks/` files, which the `§3` tree collapses to "...". The doc does have a
  `hooks/use-spinner` line in the tree but never introduces the chat hooks.

**Edit:** In `§3`, expand the `hooks/` branch to all four files. In `§9b`,
promote the selector components (`ModelSelector`, `PermissionModeSelector`,
`LoadingTimer`) and the four hooks to named bullets with a one-line purpose
each, instead of burying them in a trailing "and ...".

---

## P1 — `commands/` layer is under-described

`§7` covers chat slash actions and `§6` covers routing, but the `commands/`
folder is the third navigation/interaction layer and is only partly covered:

- `commands/command-registry.ts` — canonical command list (only 1 KB,
  clearly a small registry the doc never names).
- `commands/command-palette.tsx` (6.6 KB) + `slash-page-menu.tsx` (4.4 KB) +
  `slash-menu-items.ts` (797 B) + `keymap.ts` (2 KB) — these power the overlays
  described in `§4` "Global key handling", but the doc never says *which files*
  implement `handlePaletteKeyDown` / `handleSlashMenuKeyDown` /
  `keymap` lookup. A reader trying to find the palette code has to grep.
- `commands/export-session-markdown.ts` — the `/export` action body; `§7c`
  names the `/export` action but not the implementation file.

**Edit:** Add a short `§7d Commands package` mapping: file → role for the six
`commands/` files, and back-reference it from `§4`'s global-key-handler
paragraph (so `handlePaletteKeyDown` etc. point at the implementing file).

---

## P1 — `lib/clipboard.ts` and `utils/chat-context-utils.ts` are missing

Two files the tree omits:

- `lib/clipboard.ts` (2 KB) — clipboard read/write helper (plain text path,
  distinct from `clipboard-image.ts`).
- `utils/chat-context-utils.ts` (2.7 KB) — context helpers used by
  `ChatContextStateCard` / `ChatContextSummaryCard`; `§9b` names those cards but
  not their shared utils.

**Edit:** Add both to the `§3` tree, and mention `chat-context-utils.ts` next
to the context cards in `§9b`.

---

## P1 — `ui/` design-system layer deserves its own section

`§3` lists `cli-theme.ts`, `cli-theme-capabilities.ts`, `code-syntax-style.ts`,
`ui/components/{badge,status-dot}`, `ui/hooks/use-spinner` — but the design /
theming system is only shown as tree leaves, never explained. Given there are
tests (`cli-theme.test.ts`, `cli-theme-capabilities.test.ts`,
`use-spinner.test.ts`), this is a real, tested subsystem:

- `cli-theme.ts` — central color tokens.
- `cli-theme-capabilities.ts` — per-terminal glyph/feature detection (this is
  exactly what decides whether box-drawing/glyphs render, which matters on the
  macOS terminals the current branch is fixing).
- `code-syntax-style.ts` — syntax-highlight style.

**Edit:** Add a `§10a UI / theme layer` subsection (before or after the chat
section) explaining the theme token + capability-detection + syntax-style
trio, and note that `cli-theme-capabilities.ts` is the thing that adapts output
to the terminal — relevant to the macOS install/onboarding work on this branch.

---

## P2 — `§3` tree is truncated in the rendered doc

The directory tree in `§3` is split across a page break and the bottom half
(`utils/`, `ui/`) reads as a detached fragment after "chat-mess...". This is
cosmetic but makes the tree hard to scan.

**Edit:** Render the whole `apps/cli/src` tree as one fenced block, and make
it exhaustive (every file/dir from the real `list_files` output), so it is the
single source of truth the other sections reference.

---

## P2 — Cross-references are text-only, not linkable

`§9a` says "see `packages/ai/src/...`", `§8` says "see `lib/server-launcher.ts`
(§8)" etc., but nothing links. In a markdown doc on GitHub these could be real
relative links.

**Edit:** Convert file/path mentions that the reader will click into relative
markdown links (`[chat-screen.tsx](../../apps/cli/src/screens/chat-screen.tsx)`),
and section cross-refs into anchor links (`[§9c](#9c-the-transcript--componentschat)`).

---

## P2 — No "diagnostics-screen" detail despite it being a multiplexer

`§3` notes `diagnostics-screen.tsx` is "Reused for /status /doctor
/permissions /tools /config" — five routes into one screen — but never explains
how the screen switches between those modes. That's the most-reused screen and
the least documented.

**Edit:** Add a short `§6a Diagnostics screen multiplexing` note: how it reads
the route id (from `route-registry.ts`) to pick the panel, and which routes
share it.

---

## Summary table

| #  | Priority | Area                              | Action                                                    |
| -- | -------- | --------------------------------- | -------------------------------------------------------- |
| 1  | P0       | paste + clipboard-image pipeline  | new `§9d`; update `§3` tree                              |
| 2  | P0       | chat-message parts list stale     | finish `§9c` table; add `ChatDiffCard` to `§9b`        |
| 3  | P1       | selectors + chat hooks unnamed     | expand `§3` `hooks/`; promote `§9b` bullets to named items |
| 4  | P1       | `commands/` layer undescribed     | new `§7d` mapping; back-ref from `§4`                   |
| 5  | P1       | `clipboard.ts` / `chat-context-utils.ts` | add to `§3`, mention in `§9b`                       |
| 6  | P1       | `ui/` theme layer undescribed     | new `§10a`                                               |
| 7  | P2       | `§3` tree truncated/fragmented     | one exhaustive fenced block                            |
| 8  | P2       | cross-refs not linkable           | relative + anchor links                                  |
| 9  | P2       | diagnostics multiplexer undescribed | new `§6a`                                             |

## Recommended order of work

Do the P0s first (items 1–2): they describe features shipping on this very
branch, and a reviewer of the macOS install/onboarding PR will look for them
in the doc and not find them. Then items 3–6 (structural coverage), then 7–9
(polish). If only one edit is made, make it item 1 — the paste/image pipeline
is the most user-visible gap.
