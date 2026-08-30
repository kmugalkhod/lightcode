---
name: Lightcode Web
surface: operate
north-star: Workspace Ribbon
---

# Lightcode Web design system

Lightcode Web is one local coding workspace shared with the CLI. Keep the project conversation central and avoid dashboard cards, decorative metrics, or browser-only concepts that compete with the work.

## Colors

- Canvas `#0D1117`, panel `#121820`, raised surface `#18212B`, inset `#10151C`.
- Hairline `#273241`; use borders to separate regions instead of shadows.
- Amber `#F2A65A` is the single signature accent for the workspace ribbon, focus, and primary actions.
- Primary text `#EEF3F8`, secondary text `#B6C2CF`, muted text `#7F8D9D`.
- Status colors are restrained: green `#8BD49C`, red `#F28B82`, blue `#9CBDFD`.

## Typography

Use the native system sans stack for interface copy. Use `ui-monospace` only for paths, code, tool data, shortcuts, and model identifiers. Headings are compact and medium-bold; body copy remains 14–15px with generous line-height.

## Layout

Desktop uses a fixed 264px session rail, a full-width workspace ribbon, and a centered 900px conversation column. The composer belongs to the conversation, not a separate panel. Below 760px, the rail becomes an inert-backed drawer and the ribbon keeps project, mode, and permission visible.

## Elevation

Depth comes from adjacent charcoal tones and one-pixel hairlines. Do not add floating glass, large shadows, gradients, or unrelated card grids. Modal backdrops may use a dark translucent wash.

## Shape and spacing

Use a 7/9/11/13px radius progression and a 7/12/16/28px spacing rhythm. A control’s full painted surface is its interactive hit area; primary desktop controls are comfortably clickable and mobile controls are never below 44px. The composer and fallback folder browser may use the largest radius; core navigation remains tighter.

## Components

- Workspace ribbon: amber top rule and warm dark field; always ties path, run state, mode, and permission together.
- Session rail: saved CLI/browser conversations and one clear project chooser; do not show disabled placeholders for terminal-only customization.
- Messages: role-aligned rows with bounded code and tool disclosures; sources remain visible links.
- Composer: one dark inset surface with Agent state and a single amber send action; streaming replaces send with Stop run.
- Project chooser: one prominent full-hit-target action opens the host folder chooser first. Keep the authenticated common-location browser available as a quieter secondary action and show it automatically if the system chooser is unavailable or cannot open—including Linux without Zenity or KDialog in a graphical session. Keep non-directory and symlink rows disabled and retain confirmation before granting a broad fallback location.

## Do and don’t

Do preserve CLI terminology, make the entire visible bounds of every control interactive, show real run/permission and picker-busy state, render failures in context, and let users resume persisted sessions without choosing another folder. Don’t imitate IDE chrome, show unavailable Agents/Skills/MCP customization as disabled navigation, hide permissions, silently probe local folders, accept browser-supplied paths, or turn the application into a dashboard.
