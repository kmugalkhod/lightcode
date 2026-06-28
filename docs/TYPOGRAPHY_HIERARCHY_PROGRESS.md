# Typography & Hierarchy — Progress & Continuation Guide

**Date:** 2026-06-21  
**Status:** Major migration complete — semantic roles in place for titles, headings, labels, bodies, and captions across the CLI UI.  
**Mode:** Build. No code was run; only edits verified via typecheck later.

## What was delivered

### 1. Typography contract (cli-theme.ts)
New top-level shape:

```ts
cliTheme.typography = {
  display,   // brand / flyover title
  title,     // primary screen or section header
  section,   // sub-group / subsection inside a pane
  label,     // key or field name
  body,      // primary prose
  secondary, // supporting description
  caption,   // footnotes, hints, dim meta
  emphasis   // strong signals, callouts using accent
}
```

Each entry carries `{ color: "primary" | "secondary" | "muted" | "accent", attributes: TextAttributes }`.

Pure helpers exported for all consumers:
- `typeRole(role)` → `{ fg, attributes }` → use `<text {...typeRole("title")}>`
- `getTypographyColor(role)`, `getTypographyAttributes(role)`
- Re-exports `TextAttributes` for the few places that legitimately need raw attributes.

### 2. Systemic sweep across the entire UI tree
**Screens**
- app.tsx (Lightcode banner → display)
- chat-screen / chat-shell
- session-list-screen (title + meta states)
- model-screen + model-select-screen
- diagnostics-screen
- onboarding-screen

**Overlays & palettes**
- command-palette
- slash-page-menu
- help-overlay
- chat-interaction-popup

**Chat transcript & its cards**
- chat-message (role headers use `title`)
- chat-shell empty-state now uses display / secondary / caption
- chat-message-*-part: reasoning, tool, tool-approval
- ChatContextSummaryCard, ChatDiffCard, ChatProposedPlanCard, ChatTodoStatusCard
- copy-mode-overlay
- model-selector, permission-mode-selector

**Result**: titles are **not** built with raw "BOLD secondary" anymore. They carry semantic meaning.

## Remaining direct TextAttributes (by category)

(47 references left in the tree at freeze time. They are not bugs.)

### A. Deliberate transient state
- Row/item selection indicators: `commands/*`, `chat/chat-text-area` (mentions), `chat/chat-tool-approval-card`, `model-selector`, `permission-mode-selector`, `session-list-screen`
- Pattern (approved exception):
  ```tsx
  attributes={isSelected ? TextAttributes.BOLD : TextAttributes.NONE}
  ```
  Reason: selection is **state**, not content hierarchy.

### B. Semantic outcome / alert banners
- `"provider unavailable"` (app.tsx)
- Model + diagnostics warnings, success/error states (onboarding, session list)
- Some status words inside diagnostics tables

These are intentionally vivid because something has gone right or wrong.

### C. Low-importance trailing meta that still uses DIM directly
Examples (approximately 15–18 occurrences):
- Truncation notes in diff and proposed plan cards
- Scroll / count footers in copy-mode, diagnostics
- "active form" subtext under active todo
- A few help overlay hints

These are effectively captions and could be finished in one pass.

## Files that received material changes
```
apps/cli/src/ui/cli-theme.ts
apps/cli/src/app.tsx
apps/cli/src/screens/*
apps/cli/src/components/chat/*
apps/cli/src/components/help-overlay.tsx
apps/cli/src/commands/*
```

(Exact file count is around 25 files that now import or spread `typeRole`.)

## Continuing this work (next session)

### Recommended order
1. **Polish the remaining captions**  
   ```bash
   grep -rn 'attributes={TextAttributes.DIM}' apps/cli/src \
     --include="*.tsx" | grep -v 'isSelected'
   ```
   Replace with `{...typeRole("caption")}`.

2. **Outcome-banner cleanup (optional, higher value)**  
   Decide whether errors/warnings should route through `typeRole("emphasis")` + explicit `fg={semantic.error}` overrides for outcome color.

3. **Consider a `<Typo role="title" overrideFg={...}>` wrapper**  
   One file (`ui/components/typo.tsx`) that does the heavy lifting and never exposes TextAttributes to new authors. Existing `typeRole` spread pattern can remain as escape hatch.

4. **State layer (future design)**  
   If you want selection to affect typography:
   - Extend `typeRole` signature to accept `{ selected?: boolean }` so callers stop manually choosing BOLD/NONE.
   - Keep the dynamic selection rule hidden inside the helper.

5. **Capability regression test**  
   - On a terminal that forces no-bold:
     ```
     TERM=xterm \
     FORCE_COLOR=1 \
     ./run-cli-with-no-bold
     ```
   Verify:
   - Titles are still visible (color change alone)
   - Captions remain distinct from body

6. **Run these commands after any edit**
   ```
   bun run typecheck --filter "apps/cli"
   git diff --stat apps/cli/src
   grep -rn TextAttributes apps/cli/src --include="*.tsx" | wc -l
   ```

### One-liner to spot any new regression quickly
```bash
git diff --name-only HEAD -- 'apps/cli/src/**/*.tsx' \
| xargs grep -l 'TextAttributes\.' 2>/dev/null || true
```

## Taste notes going forward (from the frontend-design skill)

- **Amber accent (`#F2A65A`) is the distinctive voice.** Nearly every strong title / emphasis now sits close to it.
- Hierarchy is color + weight. Terminal realities limit us to these two axes.
- Use `label` aggressively on table keys / form names to give information scent.
- Keep caption small and quiet—resist the urge to emphasize incidental metadata.

## Checklist for a future agent
- [ ] Sweep remaining DIM captions
- [ ] Decide on a `<Typo>` component vs continuing manual spread
- [ ] Model outcome alerts through typography roles
- [ ] Run the full terminal capability smoke
- [ ] Update this doc with the final numbers

## Quick reference of roles
```tsx
<text {...typeRole("display")}>Lightcode</text>
<text {...typeRole("title")}>Sessions</text>
<text {...typeRole("section")}>Changes</text>
<text {...typeRole("label")}>Branch</text>
<text {...typeRole("body")}>Normal sentence.</text>
<text {...typeRole("secondary")}>Supporting line.</text>
<text {...typeRole("caption")}>2m ago · 8 files</text>
<text {...typeRole("emphasis")}>Ready</text>
```

See the final state of `cliTheme.typography` for the canonical weights and colors.

---

This file is intentionally verbose so the next agent can resume without guessing what was intentional vs accidental.