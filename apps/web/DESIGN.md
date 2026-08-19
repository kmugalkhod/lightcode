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

Use a 7/9/11/13px radius progression and a 7/12/16/28px spacing rhythm. Controls are compact but never below a comfortable touch target on mobile. The composer and folder browser may use the largest radius; core navigation remains tighter.

## Components

- Workspace ribbon: amber top rule and warm dark field; always ties path, run state, mode, and permission together.
- Session rail: saved CLI/browser conversations, project chooser, and a clearly disabled “Later” customization group.
- Messages: role-aligned rows with bounded code and tool disclosures; sources remain visible links.
- Composer: one dark inset surface with Agent state and a single amber send action; streaming replaces send with Stop run.
- Folder browser: explicit local-location gestures, disabled non-directory and symlink rows, and a second confirmation before granting any broad location-root access.

## Do and don’t

Do preserve CLI terminology, show real run/permission state, render failures in context, and let users resume persisted sessions without choosing another folder. Don’t imitate an IDE chrome, invent unavailable customization, hide permissions, silently probe local folders, or turn the application into a dashboard.
