# `apps/cli` Architecture Doc — Improvement Review

This folder holds a review of `docs/cli-architecture.md` against the current
`apps/cli/src` source, plus concrete suggestions for what to add, fix, or
restructure. It is a companion to the existing explainer, not a replacement —
the existing doc is accurate for what it covers; the items below are gaps and
opportunities found by diffing it against the real source tree (branch
`fix/macos-install-and-onboarding`).

## How this was produced

1. Read `docs/cli-architecture.md` (§1–§12).
2. Listed the real `apps/cli/src` tree (`recursive`) and compared every section
   against the files that actually exist.
3. Spot-read the under-documented / newly added files
   (`utils/clipboard-image.ts`, `utils/paste-placeholders.ts`,
   `utils/image-attachments.ts`) to confirm their purpose before recommending
   they be documented.

See `improvements.md` for the prioritized list of changes.
