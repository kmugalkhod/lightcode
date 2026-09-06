---
name: Lightcode Web
description: A precise local coding workspace built for effortless continuation.
colors:
  base: "#0d1117"
  panel: "#121820"
  elevated: "#18212b"
  inset: "#10151c"
  border: "#273241"
  border-soft: "#202a36"
  accent: "#f2a65a"
  accent-soft: "#33260f"
  accent-text: "#f6c99a"
  text: "#eef3f8"
  text-secondary: "#b6c2cf"
  text-muted: "#7f8d9d"
  success: "#8bd49c"
  warning: "#e5c07b"
  error: "#f28b82"
  info: "#9cbdfd"
typography:
  display:
    fontFamily: '"Geist Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(27px, 3vw, 38px)"
    fontWeight: 550
    letterSpacing: "-0.03em"
  body:
    fontFamily: '"Geist Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    lineHeight: 1.5
  message:
    fontSize: "15px"
    lineHeight: 1.72
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
rounded:
  tight: "7px"
  control: "8px"
  result: "9px"
  disclosure: "11px"
  container: "13px"
spacing:
  tight: "7px"
  control: "12px"
  section: "16px"
  conversation: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#23170c"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  button-secondary:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.control}"
    padding: "7px 12px"
  search:
    backgroundColor: "{colors.inset}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.control}"
    padding: "0 10px"
  session-active:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px 9px"
  model-selected:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.control}"
    padding: "12px"
---

# Design System: Lightcode Web

## Overview

**Creative North Star: "Conversation First"**

Lightcode Web is one local coding workspace shared with the CLI. Keep the project conversation central and avoid dashboard cards, decorative metrics, or browser-only concepts that compete with the work.

The interface is a precise, quiet coding instrument: adjacent charcoal fields carry the work and amber keeps project context legible. Extend this established world without simulated physical materials or a new visual identity.

**Key Characteristics:**

- Persistent project context.
- Charcoal tonal depth and amber state.
- Readable conversation with compact controls.

## Colors

### Primary

Amber is the single signature accent for focus, access controls, primary actions, and selected models. Keep persistent workspace chrome neutral; do not restore the full-width amber banner.

### Neutral

Canvas, panel, raised surface, and inset form adjacent charcoal layers. Hairlines separate regions; primary, secondary, and muted text distinguish content from supporting metadata. Green, warning amber, red, and blue communicate status rather than introducing additional brand accents.

**The Context Accent Rule.** Use amber to locate the project, current selection, focus, and next action.

## Typography

Use self-hosted Geist Variable for interface copy, with native system fallbacks for other scripts. Bundle the normal Latin variable WOFF2 as a same-origin asset with font-display swap; never depend on an external font service or relax CSP to load it. Use native monospace only for paths, code, tool data, shortcuts, and model identifiers. Geist is an intentional fit for this developer instrument, not a default identity prescription for unrelated products.

The welcome heading uses the display token and becomes 28px on mobile. Interface copy uses the body token, and messages use the more open message token. Session metadata is subordinate to prose and lives in the composer, not a second persistent header.

**The Reading Rhythm Rule.** Give conversation prose more line-height than compact navigation and controls.

## Layout

Desktop uses a fixed 280px session rail and a centered 1040px conversation column with no persistent header above the chat. Role labels sit above messages so prose, tables, and code share the available width; prose remains bounded to 72ch. Model, mode, and access controls sit directly in the composer's action row. A compact folder-name button below the composer retains the full path as a tooltip. Below 1100px the agent controls wrap as one grouped row; below 760px all controls have touch-sized targets and the session drawer opens from the compact folder-context row.

## Elevation & Depth

Depth comes from adjacent charcoal tones and one-pixel hairlines. Core workspace regions remain flat. Modal backdrops use a dark translucent wash; the existing folder dialog and command popover use localized soft shadows to separate overlapping content. These exceptions do not establish shadows for ordinary workspace regions. Do not add floating glass, decorative gradients, or unrelated card grids.

**The Flat Workspace Rule.** Separate persistent regions with tone and hairlines; reserve soft elevation for overlapping dialogs and menus.

## Shapes

Use the established tight-to-container radius progression, with the recurring 8px step for buttons, searches, session rows, and model rows. The composer and fallback folder browser use container corners; the model dialog has a nearby 14px radius. Follow the recorded spacing rhythm. A control’s full painted surface is its interactive hit area; mobile action targets are at least 44px. Core navigation remains tighter than containers.

## Components

- Buttons and fields: amber primary actions and quiet raised secondary actions, with an amber two-pixel keyboard focus outline offset by two pixels. Search fields use an inset background and amber border on focus. Disabled controls visibly dim. Color transitions are brief (160ms ease-out); drawer movement is 190ms and respects reduced motion.
- Workspace controls: no top banner or colored strip. Compact model, mode, and access selectors live in the composer. Folder selection stays native-first through a small folder-name control; full paths are available on hover, not as a permanent subtitle. Provider errors and setup states remain visible beside the folder; avoid duplicating normal session status.
- Session rail: saved CLI/browser conversations and one clear project chooser; do not show disabled placeholders for terminal-only customization.
- Messages: the same safe GitHub-flavored Markdown renderer during streaming and after completion; real tables, nested lists, and unfinished code fences retain their structure. Consecutive successful tool calls collapse into a single expandable row; errors and approval requests stay individually visible. Sources remain visible links; remote Markdown images never load automatically.
- Composer: one dark inset surface with a discoverable Commands button and a single amber send action; streaming replaces send with Stop run. Drafts persist per session/project in tab-scoped storage. Suggestions fill the composer without submitting. Browsing commands must preserve the prior draft.
- Session search: filter titles and project paths; show counts and an explicit no-results state. Recent sessions offer direct continuation from the welcome surface.
- Model picker: searchable current-provider catalog in a native modal dialog, selected model visible, exact-ID fallback, loading/error states, and serialized selection. Provider connection remains terminal-owned.
- Session context: compact Session disclosure and live status alongside Commands in the existing composer toolbar. Opening Session reveals the full title, mode, access, and message count without consuming permanent conversation height. Keep the title as a screen-reader heading and in the session rail. Offer Back to latest when the reader scrolls away from the bottom.
- Project chooser: one prominent full-hit-target action opens the host folder chooser first. Keep the authenticated common-location browser available as a quieter secondary action and show it automatically if the system chooser is unavailable or cannot open—including Linux without Zenity or KDialog in a graphical session. Keep non-directory and symlink rows disabled and retain confirmation before granting a broad fallback location.

## Do's and Don'ts

- Do preserve CLI terminology, full control hit areas, visible run and permission state, contextual errors, and direct session continuation.
- Do keep project selection explicit, native-first, and backed by the authenticated common-location fallback.
- Don't imitate IDE chrome, show terminal-only customization as disabled navigation, hide permissions, or turn the application into a dashboard.
- Don't silently probe local folders or accept browser-supplied arbitrary paths.
