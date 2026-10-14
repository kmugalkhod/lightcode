# Lightcode UI research and improvement plan (independent pass)

Author: Fable research agent. Date: 2026-10-14. Scope: `apps/cli` (OpenTUI), `apps/web` (browser UI), `apps/server` (Hono API that serves the web UI and the workspace browser). No source files were modified; the only artifact is this document. Everything marked **confirmed** was reproduced on this Windows 11 machine (Bun 1.3.13, Windows PowerShell 5.1, PowerShell 7.6 also installed) by running the real server from source on port 4999 with an isolated `LIGHTCODE_HOME` and a synthetic web-auth handoff, then driving the exact HTTP calls the web client makes. Everything marked **suspected** is reasoning from code that was not executed end to end.

---

## 1. Summary

- The web UI's project chooser is **native-first** (`POST /workspaces/picker/open`) and falls back to a **bounded "common locations" browser** (Desktop / Home / Documents / Downloads / Projects). On Windows the native picker **always fails**, and the bounded fallback **cannot reach any folder outside the user profile** (for example `D:\Self-Project\lightcode`). On macOS the native picker (`osascript`) works, so the user never notices the fallback's limits. That is the whole "Windows can't browse the project, Mac can" story.
- **Confirmed root cause (primary):** `apps/server/src/lib/native-directory-picker.ts:149` sets `$dialog.AutoUpgradeEnabled = $true` on `System.Windows.Forms.FolderBrowserDialog`. That property does not exist on .NET Framework 4.x, which is what the hard-coded `System32\WindowsPowerShell\v1.0\powershell.exe` (line 315) runs. PowerShell throws `The property 'AutoUpgradeEnabled' cannot be found on this object`, the script exits 1 (after ~18 s of WinForms warm-up), `parseWindowsResult` maps that to `native_picker_failed`, and the web app shows "The system folder picker did not open" then opens the bounded browser.
- **Confirmed contributing cause:** the bounded fallback is rooted only at profile folders (`workspace-routes.ts:1182-1239`), rejects filesystem roots (`:757`), and has no "drives / other location" entry, so a project on another drive is unreachable by design. On this machine `~/Projects` does not exist, so the "Projects" location returns a misleading `workspace_missing` ("The selected folder is no longer available.").
- **Confirmed latent cause (would bite even after the property fix):** `Bun.serve({ idleTimeout: 30 })` in `apps/server/src/index.ts:17,190` closes the socket and aborts `req.signal` for any non-chat request still pending after 30 s (verified with a 3 s idle probe). The picker route runs the dialog inside that request and kills the dialog on abort (`native-directory-picker.ts:109-114`). WinForms cold start measured 18-19 s here, leaving the user ~11 s to navigate the dialog before it vanishes. `bunServer.timeout(request, 0)` is only applied to `/sessions/:id/chat|turns` (`index.ts:20-27,194-196`).
- The bounded browser itself works on Windows (listing, drilling into junction-laden `C:\Users\<me>`, selecting) and the server-side handling of each request is single-digit milliseconds; the known-folder resolver, however, spends a fixed ~2-4 s per "open Desktop/Documents/Downloads" because it spawns PowerShell with a 2 s kill timer that PowerShell never meets on this machine (10 s cold start measured).
- Beyond the bug, the biggest UX gaps are: the TUI's IDE layout is a hard-coded three-column split with no resizing or single-panel modes; focus and keybinding discovery differ per screen; the web UI has no file/diff surface at all (parity gap with the TUI); the project chooser dialog is modal and shows files it cannot act on; and both surfaces hide or mislabel platform specifics (Windows hidden/system items, OneDrive-redirected Desktop, missing Projects).

---

## 2. Current UI map

### 2.1 Terminal UI (`apps/cli/src`)

| Layer | Files | Notes |
| --- | --- | --- |
| Entry / shell | `index.tsx` (boot, `web` sub-command at :13-37), `app.tsx` (`MemoryRouter`, global keymap, palette, help, Ctrl+C logic, footer status) | Routes: `/`, `/sessions`, `/sessions/:id`, `/status`, `/doctor`, `/permissions`, `/tools`, `/config`, `/model`, `/model-info`, onboarding. |
| State | `state/app-state.tsx` | Palette/slash menu state, `changesPanelOpen`, `editorActive`, footer chat status, abort handler. |
| Keymap / commands | `commands/keymap.ts` (F1 help, F2 IDE panel, Ctrl+P palette, Ctrl+G back, Ctrl+O tool output, Ctrl+R reasoning, Ctrl+C/Q quit), `commands/command-registry.ts`, `commands/command-palette.tsx`, `commands/slash-page-menu.tsx`, `commands/slash-menu-items.ts`, `commands/chat-slash-actions.ts` | Help overlay is generated from the keymap but the many chat-local keys (Tab, `[`/`]`, `d`, `e`, `w`, `r`, Ctrl+Y, Ctrl+T) are hard-coded in `screens/chat-screen.tsx:1138-1378` and only partly surfaced in the input footer hint. |
| Screens | `screens/home-screen.tsx` (ASCII art + server status + prompt), `screens/chat-screen.tsx` (1,789 lines; owns every chat, panel, editor, copy-mode and approval state), `screens/session-list-screen.tsx`, `screens/model-select-screen.tsx`, `screens/model-screen.tsx`, `screens/diagnostics-screen.tsx`, `screens/onboarding-screen.tsx` | |
| Chat components | `components/chat/chat-shell.tsx` (title row + bordered scrollbox + input slot), `chat-message.tsx` + `chat-message-*-part.tsx`, `chat-text-area.tsx` (paste collapsing, image chips, @-mentions), `chat-tool-approval-card.tsx`, `chat-interaction-popup.tsx`, `chat-proposed-plan-card.tsx`, `chat-todo-status-card.tsx`, `chat-context-summary-card.tsx`, `copy-mode-overlay.tsx`, `permission-mode-selector.tsx`, `loading-timer.tsx`, `model-selector.tsx` | |
| IDE layout | `components/chat/ide-layout.tsx` (fixed 22% / flex / 34% columns, header tabs "Terminal / IDE", VS Code style status bar), `file-explorer-panel.tsx` (ExplorerTree, ChangesTab, EditorPane, tab strip, placeholders), `file-editor.tsx`, hooks `use-file-tree.ts`, `use-file-content.ts`, `use-git-changes.ts`, `use-changed-files.ts`, `panel-toggle-button.tsx`, `breadcrumb.tsx`, `chat-diff-card.tsx` | Activated with F2 when terminal width >= 100 (`chat-screen.tsx:557-560`). Focus model: Tab moves focus into the explorer, Esc returns, `e` edits in place. |
| Theme / typography | `ui/cli-theme.ts` (charcoal + amber tokens, `typography` roles, `typeRole()`), `ui/cli-theme-capabilities.ts` (unicode / reduced motion / glyph fallbacks), `ui/code-syntax-style.ts`, `ui/file-type-style.ts`, `ui/components/badge.tsx`, `ui/components/status-dot.tsx`, `ui/hooks/use-spinner.ts` | Documented in `docs/TYPOGRAPHY_HIERARCHY_PROGRESS.md`. |

### 2.2 Web UI (`apps/web/src`) and how the server serves it

| Layer | Files | Notes |
| --- | --- | --- |
| Serving | `apps/server/src/routes/web-routes.ts` (serves `apps/web/dist` or `dist/assets/web` under `/app/*`, SPA fallback, CSP), `apps/server/src/lib/web-auth.ts` (per-launch bearer token from a handoff file, Host/Origin/Fetch-Metadata checks, `authenticatedWebRequests` marker used by the picker), `apps/cli/src/lib/server-launcher.ts` (`lightcode web` picks a port from `LIGHTCODE_WEB_PORT`, writes the handoff file, sets `PORT` and `LIGHTCODE_WEB_AUTH_FILE` for the child), `apps/cli/src/lib/web-launcher.ts` (opens the browser via a temp `open.html` so the token is only in the URL fragment) | |
| App shell | `app.tsx` (auth gate, session list, workspace selection, native picker flow `openNativeProjectPicker` :354-400, fallback notice mapping :46-103, keyboard: Ctrl/Cmd+Shift+N new session, Ctrl/Cmd+K session search) | |
| Components | `session-rail.tsx` (280 px rail: brand, New session, project button, search, list, footer), `workspace-ribbon.tsx` (project button + status; model / mode / permission selects), `chat-surface.tsx` (streaming chat, follow-output, Back to latest), `chat-message.tsx` (markdown, grouped completed tools, reasoning disclosure), `message-markdown.tsx`, `command-composer.tsx` (draft persistence, slash menu, session disclosure, send/stop), `slash-command-menu.tsx`, `model-picker.tsx` (`<dialog>`), `project-browser.tsx` (bounded folder browser modal), `icons.tsx` | |
| Client API | `lib/api.ts` (zod-parsed fetch wrapper; `listEntries` marks only `directory && readable` rows selectable at :569), `lib/workspace-location.ts`, `lib/slash-command-registry.ts`, `lib/web-command-executor.ts`, `lib/composer-draft.ts`, `lib/exclusive-request-gate.ts` | |
| Styles | `styles.css` (2,412 lines, dark-only tokens on `:root`, breakpoints at 1100 / 980 / 760 / 460 / 400 px, reduced-motion block) | Design intent in `apps/web/DESIGN.md`. |

### 2.3 Workspace / project browsing API (`apps/server/src/routes/workspace-routes.ts`, schemas in `packages/ai/src/workspace-browser.ts`)

| Route | Purpose | Key code |
| --- | --- | --- |
| `POST /workspaces/picker/open` | Runs the OS folder dialog (PowerShell WinForms / osascript / zenity / kdialog) inside the request; returns a workspace grant. Requires an authenticated browser request. | `:1315-1366`; picker in `lib/native-directory-picker.ts` |
| `GET /workspaces/locations` | Static list of five known-folder locations (unprobed). | `:1367-1375`, definitions `:1182-1239` |
| `POST /workspaces/browser/open` | Resolves one known folder lazily (PowerShell known-folder query on Windows with a 2 s kill timer `:283`; OneDrive env fallbacks `:405-426`), canonicalises it, rejects filesystem roots (`:757`), issues a 10-minute browser capability. | `:1376-1432` |
| `POST /workspaces/browser/:id/entries` | Lists a directory addressed by path *segments* (no host paths from the browser), with symlink / escape / identity checks, HMAC cursor paging, and an `includeHidden` flag that only understands dot-prefixed names (`:1486`). | `:1433-1547`, `describeEntry` `:1048-1104` |
| `POST /workspaces/browser/:id/select` | Converts the current segments into a workspace grant (`pathLabel` is `Location/seg/seg`, never a host path). | `:1548-1597` |
| `POST /workspaces/:workspaceId/sessions` | Creates a session bound to the grant's canonical root and inode identity. | `:1598-1637` |

The path handling itself is Windows-safe: it uses `path` (win32 on Windows) consistently, `path.relative`-based containment (`:741-749`), realpath for canonical form, and never splits on `/`. Bun's `realpath`, `lstat`, `access(R_OK|X_OK)`, `opendir().read()`/`closeSync()` and `bigint` inodes all behaved correctly on NTFS in my probes (inode non-zero, realpath case-normalising and stable).

---

## 3. UX problems (prioritised, with evidence)

Severity: P0 blocks a core flow, P1 materially hurts daily use, P2 polish.

### P0

1. **Windows users cannot open a project in the web UI unless it lives under their profile.** Native picker always fails on Windows PowerShell 5.1 (`native-directory-picker.ts:149`), fallback browser roots are profile folders only (`workspace-routes.ts:1182-1239`). Full analysis in section 4.
2. **Slow, opaque failure path for the picker.** The user clicks "Choose project", sees a spinner labelled "Opening folder picker" for ~18 s (WinForms warm-up measured 17.9-19.1 s), then gets "The system folder picker did not open" with no reason. Nothing tells them the fallback cannot reach other drives. (`app.tsx:96-102`, `project-browser.tsx:490-529`.)
3. **The picker request is subject to the 30 s HTTP idle timeout.** Confirmed with a probe that Bun aborts the request and `req.signal` fires; the picker's abort handler kills the dialog (`native-directory-picker.ts:103-114`). Any slow dialog (first PowerShell start, Defender scan, user hesitation) gets killed mid-use with a generic "did not open" error. Also affects `browser/open` on Windows when PowerShell is slow (2 s cap today, so it does not trip, but it costs 2-4 s per click: measured 3.8 s Desktop, 3.1 s Documents, 2.7 s Downloads from a Bun client against a 2 ms Home open).

### P1 (web)

4. **"Projects" location returns a misleading error** when `~/Projects` does not exist: HTTP 404 `workspace_missing` "The selected folder is no longer available." rendered under the heading "This folder could not be opened" with a Retry button that can never succeed (`workspace-routes.ts:640-647`, `resolveProjectsDirectoryPath` :569-610, `project-browser.tsx:537-559`). Locations are listed as `unprobed`, so the UI cannot grey them out in advance.
5. **Windows noise in the bounded browser.** Hidden detection is dot-prefix only (`workspace-routes.ts:1486`, mirrored in `api.ts:567`), so Home shows `NTUSER.DAT*`, `ntuser.ini`, `desktop.ini`, and 9+ legacy junctions ("Application Data", "My Documents", "Cookies", "SendTo", ...) rendered as disabled "linked folder" rows. Files are listed at all even though they are never actionable (`project-browser.tsx:576-582`); on this Desktop that is ~40 PDF/LNK rows before any folder. On macOS the same code shows a tidy list, so the Windows experience is visibly worse.
6. **No way to see or type the real path.** The grant `pathLabel` is `Desktop/foo`, not `C:\Users\me\OneDrive\Desktop\foo`; the session rail and ribbon derive the project name from that label (`session-rail.tsx:125`, `workspace-ribbon.tsx:51-53`). With OneDrive-redirected Desktop (`C:\Users\kmuga\Desktop` does not exist here), users cannot tell which Desktop they opened. There is also no recent-projects list and no "paste a path" affordance, which every comparable tool offers (VS Code, Cursor, Zed, OpenCode's `opencode <dir>`).
7. **Web UI has no file, diff or tool-output surface beyond the chat column.** The TUI has an Explorer / Changes / Editor; the browser has only grouped tool rows inside messages (`chat-message.tsx:88-95`). PRODUCT.md promises parity of "tool activity" but the browser cannot show what the agent changed, nor open a file. This is the largest TUI/web inconsistency.
8. **Project chooser is a modal that blocks the whole app and traps focus**, including while the native picker is pending (`project-browser.tsx:377-415`, `inert` on main in `app.tsx:474`). If the OS dialog opens behind the browser window (WinForms owner form is positioned off-screen at -32000,-32000 with `TopMost`, `native-directory-picker.ts:134-141`), the user sees a frozen page and no dialog.
9. **Session rail and composer controls disable without explanation**: "New session" is disabled until a workspace exists (`session-rail.tsx:68`), composer placeholder says "choose a project first" but the only visible project action is the native picker that fails on Windows; "Browse folders" is a small secondary button under the starter composer only (`app.tsx:663`) and is absent from the rail and from the chat view's ribbon.
10. **Dark-only theme and no `prefers-color-scheme`** (`styles.css:9-28`). Fine for a dev tool, but the design doc calls the browser "the same instrument as the terminal" while the TUI's palette lives separately in `cli-theme.ts`: the two token sets are duplicated by hand (same hex values, different names, `--text-muted` is `#7f8d9d` on web vs `#7A8796` in the TUI).

### P1 (TUI)

11. **IDE layout is rigid.** Column widths are hard-coded (`ide-layout.tsx:131-139`: 22% / flex / 34%, min 22 / 40 cols) with no resize, no collapse of the explorer or chat, and the whole mode is suppressed under 100 columns (`chat-screen.tsx:557`). Common cases (editor + chat only, explorer + chat only) are impossible. OpenCode and Claude Code avoid this by keeping a single conversation column with overlays; Zed/Cursor let the agent panel be resized or docked.
12. **Keyboard model is inconsistent across screens and partly undiscoverable.** Global keymap (`keymap.ts`) covers 10 bindings; the chat screen adds ~15 context keys inline (`chat-screen.tsx:1138-1378`) that the F1 help overlay (`help-overlay.tsx`) does not list; Tab means "cycle mode" without the panel and "focus explorer" with it (`:1370-1377`); Esc leaves the panel but `q` is intentionally not quit; back is Ctrl+G. There is no leader-key scheme like OpenCode's `ctrl+x <key>` and no on-screen key legend outside the one-line input hint, which is clipped in the narrow IDE chat column (`:1439`).
13. **`chat-screen.tsx` is a 1,789-line god component** owning chat, approvals, plan review, copy mode, explorer, editor tabs, git state and the key handler. Every UI change to any panel touches it; it is the single biggest obstacle to iterating on the TUI.
14. **Home screen is mostly decoration.** `home-screen.tsx` centres ASCII art, server status and a prompt; there is no recent-session list, no project indicator beyond cwd, no quick actions, whereas the web "new session" surface already has suggestions and recent sessions (`app.tsx:552-681`). Parity gap in the other direction.
15. **Message density and hierarchy.** Each message is a bordered, background-filled card with a title-weight role label (`chat-message.tsx:127-132`); tool parts, reasoning and errors each add more boxes. Long sessions become a wall of boxes; `docs/TYPOGRAPHY_HIERARCHY_PROGRESS.md` acknowledges the hierarchy work is unfinished. Modern agent TUIs (Claude Code, OpenCode) use a left gutter marker plus whitespace instead of full card borders for assistant text.

### P2

16. Empty / loading states are inconsistent: the TUI has `PanePlaceholder` for panes but plain text for "Not a git repository." / "No changes." (`file-explorer-panel.tsx:362-369`); the web has skeletons for sessions and folders but a bare `<p>` for "No sessions yet".
17. Web composer mobile breakpoints exist, but the project browser dialog has only two breakpoints (`styles.css:2036-2050`) and the folder list has no virtualisation; `limit: 100` with "Load more folders" appends into one long scroll.
18. The `WorkspaceRibbon` status pill shows "Checking" / "Ready" / "Setup needed" but only when there is no session (`workspace-ribbon.tsx:111`); provider errors during a session are invisible until a send fails.
19. Keyboard shortcuts rendered as `⇧ N` / `⌘ K` on Windows (`session-rail.tsx:71,86`) where the real modifier is Ctrl.
20. The TUI editor tab strip clips instead of scrolling (`file-explorer-panel.tsx:766-803`), max 8 tabs, no "unsaved changes" guard on close beyond the dirty dot.

---

## 4. Windows traversal bug: root cause and fix design

### 4.1 Reproduction (what I ran)

```
# server from source, isolated data dir, synthetic browser handoff
PORT=4999 LIGHTCODE_HOME=<scratch>/lc-home LIGHTCODE_WEB_AUTH_FILE=<scratch>/handoff.json \
  bun --env-file=.env apps/server/src/index.ts
# then, as the web client (Bearer token, X-Lightcode-Client: web, Origin, Sec-Fetch-Site):
GET  /workspaces/locations                        -> 5 locations, all "unprobed"
POST /workspaces/browser/open {locationId:home}   -> 201 in 2 ms
POST /workspaces/browser/<id>/entries {segments:[]}             -> 200 in 42 ms (46 rows incl. NTUSER.DAT, 9 junctions)
POST /workspaces/browser/<id>/entries {segments:["AppData","Local"]} -> 200 (drill-down works)
POST /workspaces/browser/<id>/select  {segments:["Documents"]}  -> 201 grant {pathLabel:"Home/Documents"}
POST /workspaces/browser/open {locationId:desktop}   -> 201 in 3.8 s   (PowerShell killed at 2 s, OneDrive fallback)
POST /workspaces/browser/open {locationId:projects}  -> 404 workspace_missing in 3 ms (~/Projects absent)
```

The native picker was exercised with its exact script prologue (everything before `ShowDialog`, so no dialog appears):

```
exit=1 after 17966 ms
STDERR: ... The property 'AutoUpgradeEnabled' cannot be found on this object.
        At line:8 char:1  + $dialog.AutoUpgradeEnabled = $true
```

Bun `idleTimeout` semantics were verified with a 3 s idle server and a 6 s handler: the client got "The socket connection was closed unexpectedly" at 4.1 s and the server saw `req.signal` abort.

### 4.2 Full trace, client to filesystem

1. User clicks the project button (rail `session-rail.tsx:79`, ribbon `workspace-ribbon.tsx:76`, or "New session" with no workspace `app.tsx:290-294`) -> `openNativeProjectPicker()` (`app.tsx:354`) -> `api.openWorkspacePicker()` -> `POST /workspaces/picker/open` (`api.ts:502`).
2. Server: `createWebSecurityMiddleware` marks the request authenticated (`web-auth.ts`, `authenticatedWebRequests.add`), route checks `isAuthenticatedWebRequest` (`workspace-routes.ts:1323`), then `nativeDirectoryPicker.pick(c.req.raw.signal)` (`:1336`).
3. `resolvePickerCommand` (`native-directory-picker.ts:301-335`) hard-codes `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (.NET Framework 4.8) with `-NonInteractive -STA -EncodedCommand <windowsPickerScript>`.
4. `windowsPickerScript` (`:128-158`) does `Add-Type System.Windows.Forms` (slow: "Preparing modules for first use", 18-19 s cold), then at line 149 `$dialog.AutoUpgradeEnabled = $true`. **On .NET Framework `FolderBrowserDialog` has no such member** (it was added to WinForms in .NET Core 3.x / .NET 5+; `AutoUpgradeEnabled` exists on `FileDialog` only in .NET Framework). PowerShell raises a terminating `PropertyAssignmentException`; `$ErrorActionPreference='Stop'` makes it fatal; nothing is written to stdout; exit code 1.
5. `parseWindowsResult` (`:214-222`) sees `exitCode !== 0` -> `NativeDirectoryPickerError("native_picker_failed", "The Windows folder picker could not be opened.")` -> `mapNativePickerError` -> HTTP 500 `native_picker_failed`.
6. Client `openNativeProjectPicker` catch (`app.tsx:389-395`) -> `nativePickerFallbackNotice` default branch (`:96-102`) -> `setIsBrowserOpen(true)` -> `ProjectBrowser` modal with the notice "The system folder picker did not open".
7. In the modal the user can only open Desktop / Home / Documents / Downloads / Projects. Each root is resolved server-side (`workspace-routes.ts:1395-1408`); the browser can never supply a path; `isFilesystemRootPath` rejects drive roots (`:757`); segments cannot contain `\` or `:` (`workspace-browser.ts:64-72`). A project at `D:\Self-Project\lightcode` is therefore unreachable. Home browsing *does* work (confirmed), it just cannot leave `C:\Users\<user>`.
8. On macOS step 3 uses `/usr/bin/osascript` with `choose folder`, which appears in well under a second and returns any POSIX path, so the user picks the project directly and never sees steps 6-7.

### 4.3 Confirmed vs suspected

| # | Finding | Status | Evidence |
| --- | --- | --- | --- |
| A | `AutoUpgradeEnabled` assignment fails under Windows PowerShell 5.1 -> picker always returns `native_picker_failed` on Windows | **Confirmed** | Probe output above; `native-directory-picker.ts:149,315` |
| B | Bounded fallback cannot reach other drives / outside the profile; Projects location 404s when absent | **Confirmed** | HTTP runs above; `workspace-routes.ts:757,1182-1239,640-647` |
| C | Bun `idleTimeout: 30` aborts the picker request and kills the dialog if the user takes > 30 s including WinForms warm-up (~18 s) | **Confirmed mechanism** (idle probe + 18 s warm-up measurement); end-to-end with a real dialog not run because it would pop a GUI | `index.ts:17,190-196`; `native-directory-picker.ts:103-114` |
| D | WinForms owner form at (-32000,-32000) may leave the dialog behind the browser / on no monitor once A is fixed | **Suspected** | `native-directory-picker.ts:134-141` |
| E | `-NonInteractive` is compatible with `ShowDialog` (it only disables console prompts) | **Suspected OK**, untested | `:327` |
| F | Known-folder PowerShell resolver never finishes inside its 2 s budget here (10.3 s cold), so Desktop/Documents/Downloads rely on the OneDrive/`USERPROFILE` fallbacks and cost 2-4 s per open | **Confirmed** | `workspace-routes.ts:223-301,283`; timings above |
| G | Windows hidden/system attributes ignored, junctions shown as disabled rows, files listed | **Confirmed** | entries output; `workspace-routes.ts:1486`, `api.ts:567-569` |
| H | Low-level Bun fs on NTFS (realpath, lstat, access X_OK, opendir, bigint ino) | **Confirmed working** (sub-ms) | `bench-fs.ts` probe |
| I | `dist/` in the repo is a stale 0.7.1 build without the picker; the user's Windows install must be a newer published package or source | Observed | `dist/package.json` |

### 4.4 Fix design

**Fix 1 - make the Windows picker actually run (S).** `apps/server/src/lib/native-directory-picker.ts`
- Remove `$dialog.AutoUpgradeEnabled = $true` (line 149) or guard it: `if ($dialog.PSObject.Properties['AutoUpgradeEnabled']) { $dialog.AutoUpgradeEnabled = $true }`.
- Prefer `pwsh.exe` (PowerShell 7, .NET 8+, modern Vista-style folder dialog with an address bar) when present, falling back to `powershell.exe`. Discovery must stay allow-listed: `%ProgramFiles%\PowerShell\7\pwsh.exe` and the `WindowsApps` alias, never `PATH` lookup (keeps the current no-`PATH` threat model). Both engines must pass the same output contract (`selected:<base64>` / `cancelled`).
- Alternative that avoids WinForms warm-up entirely: drive `IFileOpenDialog` with `FOS_PICKFOLDERS` via `Add-Type` C# shim, or call the Shell COM `Shell.Application.BrowseForFolder`. Cheaper first step: keep WinForms but drop `-NonInteractive`? Not needed; keep it.
- Replace the off-screen owner form with `$owner.TopMost=$true; $owner.Show(); $owner.Activate(); $owner.BringToFront()` on the primary screen with `Opacity=0` *and* a `$dialog.ShowDialog($owner)` after `[System.Windows.Forms.Application]::EnableVisualStyles()`; or simply pass `New-Object System.Windows.Forms.NativeWindow` wrapping the foreground window. Verify manually that the dialog is in front of Chrome/Edge.
- Tests: `native-directory-picker.test.ts` currently mocks `runProcess` for every Windows case, so it can never catch a broken script. Add one opt-in integration test (`LIGHTCODE_NATIVE_PICKER_SMOKE=1`) that runs the script prologue without `ShowDialog` on win32 and asserts exit 0, plus a unit assertion that the encoded script does not contain `AutoUpgradeEnabled` unguarded.

**Fix 2 - exempt long-running local-UI requests from the idle timeout (S).** `apps/server/src/index.ts`
- Extend `isChatStreamingRoute` into `isLongRunningRoute` covering `POST /workspaces/picker/open` and `POST /workspaces/browser/open`, calling `bunServer.timeout(request, 0)` (or a generous 10 min for the picker). Keep the server-side `AbortSignal` wiring so a closed tab still cancels the dialog.
- Client: `openNativeProjectPicker` should show progressive copy ("Opening the system folder dialog... first launch can take ~20 s on Windows") and a Cancel that aborts the fetch (which already kills the dialog through `req.signal`).

**Fix 3 - make the bounded browser able to reach any local project (M).** `workspace-routes.ts`, `workspace-browser.ts`, `project-browser.tsx`, `api.ts`
- Add a `drives` / `computer` known-location on win32 that lists mounted drive letters (via `wmic`-free approach: probe `A:`..`Z:` with `fs.stat`, or `Get-PSDrive -PSProvider FileSystem` via the same PowerShell seam) and, on POSIX, `/`-level mounts or `/Volumes`. The *root* capability would be the virtual "Computer" node; selecting a bare drive root stays rejected (today's `isFilesystemRootPath` rule), but navigating *through* it to `D:\Self-Project\lightcode` must be allowed. This needs a small schema change: location `kind: "drives"` and segments whose first element is a drive label validated against the server-side list (never user-supplied paths).
- Add a **"Recent projects"** section sourced from existing sessions (`cwd` is already stored per session; the server can re-grant a previous cwd after re-canonicalising and identity-checking it). This alone would have let the user reopen a project they had used from the TUI.
- Add an **explicit "Open path..." input that posts a host path** only through a new `POST /workspaces/grants/from-path` endpoint restricted to authenticated browser requests, with the same canonicalisation, root rejection, symlink checks and a confirmation step. PRODUCT.md currently forbids browser-supplied arbitrary paths; this is a product decision (see Risks). If kept forbidden, Fix 3a (drives) is mandatory.
- Probe locations at `GET /workspaces/locations` time (cheap `fs.stat`, no PowerShell) and return `state: "missing"` so the UI can grey out "Projects" instead of 404-ing; keep the lazy PowerShell lookup only for Desktop/Documents/Downloads when actually opened.

**Fix 4 - Windows-aware listing (S).** `workspace-routes.ts` `describeEntry`/entries loop, `api.ts`
- Treat NTFS `hidden`/`system` attributes as hidden (Bun exposes `stats.mode` only; use `fs.stat` + `isHidden` via `attributes` when available, or at minimum a name allow/deny list for `NTUSER.DAT*`, `ntuser.ini`, `desktop.ini`, `*.lnk`, junction names). Cheaper and portable: hide `kind: "symlink"` rows whose `symlinkState` is `internal` *and* name is one of the well-known profile junctions, and hide known registry hive files.
- Return `entries` with directories first and let the client request `directoriesOnly: true` (the web browser never acts on files) with an optional "Show files" toggle.
- Drop the 2 s PowerShell cap to a first-call cache: resolve known folders once per server process (`Map<kind, Promise<string>>`) so the 10 s hit is paid at most once, off the request path (kick it off at first `GET /locations`).

**Fix 5 - honest error copy (S).** `app.tsx:nativePickerFallbackNotice`, `project-browser.tsx`
- Distinguish `native_picker_failed` with a platform hint ("Windows folder dialog failed to start (PowerShell). Browse a location below or open a recent project.").
- For `workspace_missing` on *open location* use "Projects folder not found at `~/Projects` - set `LIGHTCODE_PROJECTS_PATH` or pick another location", not "no longer available".

Acceptance for the bug as a whole: on a Windows 11 machine with the project on `D:\`, `lightcode web` -> Choose project -> the OS dialog appears in front of the browser within 2 s on second launch (<= 20 s first launch, with progress copy), selecting `D:\Self-Project\lightcode` yields a grant and a new session whose `cwd` is that path; and with the native dialog forced unavailable (`LIGHTCODE_NATIVE_PICKER=off` test seam) the bounded browser can still reach the same folder through "Computer > D: > Self-Project > lightcode" or "Recent projects".

---

## 5. Improvement plan (phases)

Effort: S = under a day, M = 1-3 days, L = a week or more. Each item lists files to touch and acceptance criteria.

### Phase 0 - Unblock Windows (ship first)

| # | Item | Files | Effort | Acceptance |
| --- | --- | --- | --- | --- |
| 0.1 | Fix picker script (Fix 1), prefer pwsh, guard property, bring dialog to front | `apps/server/src/lib/native-directory-picker.ts`, `.test.ts` | S | Script prologue exits 0 under both `powershell.exe` and `pwsh.exe`; manual run shows dialog in front of browser; existing tests pass; new smoke test guarded by env var |
| 0.2 | Exempt picker/open routes from idle timeout (Fix 2) | `apps/server/src/index.ts` | S | Picker request stays open > 30 s without socket close (probe test); chat timeouts unchanged |
| 0.3 | Progressive picker status + Cancel in web | `apps/web/src/app.tsx`, `session-rail.tsx`, `workspace-ribbon.tsx`, `styles.css` | S | After 3 s the button copy explains the wait; Cancel aborts fetch and the dialog closes |
| 0.4 | Known-folder resolution cached, probed at `/locations`, `missing` state | `apps/server/src/routes/workspace-routes.ts`, `packages/ai/src/workspace-browser.ts`, `apps/web/src/lib/api.ts`, `project-browser.tsx` | S/M | Opening Desktop a second time < 50 ms; "Projects" shows disabled with tooltip when absent; no 404 for never-existing locations |
| 0.5 | Windows-aware hidden filtering + directories-first + files hidden by default (Fix 4) | `workspace-routes.ts`, `api.ts`, `project-browser.tsx` | S | Home listing on Windows shows only real folders by default; toggle reveals files/hidden; tests cover junction and hive names |

### Phase 1 - Project access model (web + server)

| # | Item | Files | Effort | Acceptance |
| --- | --- | --- | --- | --- |
| 1.1 | "Recent projects" from session history, re-granted server-side | `workspace-routes.ts` (new `GET /workspaces/recent`, `POST /workspaces/recent/:key/grant`), `chat-store.ts` (query distinct cwd), `api.ts`, `session-rail.tsx`, `project-browser.tsx` | M | A project used from the TUI appears in the web rail and opens with one click after identity check; removed folders show as unavailable |
| 1.2 | "Computer / Drives" location (Fix 3a) | `workspace-browser.ts` (location kind), `workspace-routes.ts`, `project-browser.tsx` | M | On Windows, D:\ projects reachable through the bounded browser; drive root itself still not selectable; symlink/escape tests extended |
| 1.3 | Decide on "Open path..." (Fix 3c) | PRODUCT.md decision first; then `workspace-routes.ts`, `project-browser.tsx` | S after decision | Either documented as rejected, or implemented behind confirmation with the same canonicalisation tests |
| 1.4 | Non-modal project chooser: convert `ProjectBrowser` into a side sheet docked to the rail, keep app interactive, no focus trap while the OS dialog is pending | `project-browser.tsx`, `app.tsx`, `styles.css` | M | Chat remains usable while browsing; Esc closes; focus returns to trigger; axe/ARIA checks pass |
| 1.5 | Show real path on hover/`title` and in a "Project" disclosure; platform-correct shortcut glyphs | `workspace-ribbon.tsx`, `session-rail.tsx`, `api.ts` (`pathLabel` from server can stay abstract; add optional `hostPath` returned only to authenticated browser clients) | S | Tooltip shows `C:\Users\...\OneDrive\Desktop\foo`; `Ctrl` shown on non-mac |

### Phase 2 - Web workspace surfaces (parity with TUI)

| # | Item | Files | Effort | Acceptance |
| --- | --- | --- | --- | --- |
| 2.1 | "Changes" drawer: list of files changed this session + git status, with unified diff view | New `apps/web/src/components/changes-drawer.tsx`, `diff-view.tsx`; server: expose existing git-change logic from `apps/cli/src/components/chat/use-git-changes.ts` as `GET /sessions/:id/changes` + `GET /sessions/:id/diff?path=` in `apps/server/src/routes/chat-routes.ts` (reuse `packages/ai/src/git`) | L | Opening the drawer during/after a run lists changed files with +/- counts; clicking shows a diff; keyboard reachable; works at 760 px as a full-screen sheet |
| 2.2 | File viewer (read-only) for `@` mentions and tool outputs; later edit | `GET /sessions/:id/files?path=` (bounded by grant root using the same `isContainedPath` rules), `file-viewer.tsx` | M | Any file path in a tool row is a link that opens the viewer; path escapes rejected with tests |
| 2.3 | Tool activity timeline rail (collapsible, right side) instead of only inline grouped rows; keep inline for errors/approvals | `chat-message.tsx`, new `activity-rail.tsx`, `styles.css` | M | Users can scan tool calls without scrolling the transcript; approvals still inline and focus-managed |
| 2.4 | Theme tokens shared with the TUI: generate `styles.css` `:root` and `cli-theme.ts` from one JSON in `packages/shared/src/theme.ts`; add light theme and `prefers-color-scheme` | `packages/shared/src/theme.ts` (new), `apps/web/src/styles.css`, `apps/cli/src/ui/cli-theme.ts`, build script | M | Single source of truth; contrast checks pass in both schemes; TUI unchanged visually |
| 2.5 | Responsive polish: virtualised folder/session lists, dialog breakpoints, 44 px targets in the project browser | `project-browser.tsx`, `session-rail.tsx`, `styles.css` | S | 1,000-entry folder scrolls smoothly; 320 px layout has no overflow |

### Phase 3 - TUI panel system

| # | Item | Files | Effort | Acceptance |
| --- | --- | --- | --- | --- |
| 3.1 | Split `chat-screen.tsx` into `use-chat-session.ts` (hook), `use-ide-panels.ts` (panel/editor/git state), `chat-keymap.ts` (context key tables), and a thin screen | `apps/cli/src/screens/chat-screen.tsx` -> `apps/cli/src/screens/chat/*.ts(x)` | L | No behaviour change; existing tests pass; screen file < 400 lines |
| 3.2 | Panel manager: layouts `chat`, `chat+explorer`, `chat+editor`, `ide`; cycle with F2, Ctrl+B toggles explorer, Ctrl+J toggles chat column; widths adjustable with Ctrl+Left/Right in 4-col steps and persisted in `~/.lightcode/settings.json` (`tui.layout`) | `ide-layout.tsx`, `state/app-state.tsx`, `keymap.ts`, settings schema in `packages/ai/src/config` | M | Each layout renders at 80, 100, 140 cols without clipping; widths persist across runs |
| 3.3 | Unified keymap with a leader key (default `ctrl+x`) and a context-aware key legend row at the bottom (replaces the clipped single-line hint); F1 help lists all contexts | `keymap.ts`, `help-overlay.tsx`, `chat-screen` key tables, `app.tsx` footer | M | Every key that does something appears in F1 for its context; legend changes when focus moves between chat / explorer / editor |
| 3.4 | Message rendering: gutter-marker style for assistant/user text (no full borders), cards only for tools, approvals, errors, plans; compact tool rows with one-line summaries expanding on Ctrl+O | `components/chat/chat-message.tsx`, `chat-message-tool-invocation-part.tsx`, `cli-theme.ts` roles | M | A 40-message session fits ~30 % more content per screen; screenshot review against OpenCode/Claude Code transcripts |
| 3.5 | Home screen: recent sessions list, current project path, quick actions (`/sessions`, `/model`, IDE), server status inline | `screens/home-screen.tsx`, `components/home-*.tsx` | S | Enter on a recent session resumes it; no ASCII art above 20 rows unless terminal >= 40 rows |
| 3.6 | Explorer/editor polish: scrollable tab strip, unsaved-changes prompt, git status in tree header, search in tree (`/` within explorer) | `file-explorer-panel.tsx`, `file-editor.tsx`, `use-file-tree.ts` | M | 20 open tabs navigable; closing a dirty tab asks; tree filter works |

### Phase 4 - Shared / server

| # | Item | Files | Effort | Acceptance |
| --- | --- | --- | --- | --- |
| 4.1 | Workspace API hardening tests on Windows paths (drive letters, junctions, OneDrive, case-insensitive containment) | `workspace-routes.test.ts` with win32 `path` seams | S | CI passes on `windows-latest` runner |
| 4.2 | Diagnostics: `GET /diagnostics/doctor` check for "native picker available" that runs the script prologue; surfaced in web and TUI `/doctor` | `diagnostics-routes.ts`, `native-directory-picker.ts` | S | Doctor reports the PowerShell/.NET combination and the picker outcome |
| 4.3 | Log picker and location failures with stderr excerpt at warn level (currently swallowed) | `native-directory-picker.ts`, `workspace-routes.ts` | S | Failure reasons visible in `logs/server-*.log` |

Suggested order: Phase 0 (one short release), then 1.1/1.2 together, then 2.1 and 3.1-3.3 in parallel streams (web and TUI are independent), then the rest.

---

## 6. Risks and open questions

1. **Product policy on browser-supplied paths.** PRODUCT.md and README state the browser never submits an arbitrary host path. "Recent projects" and "Computer/Drives" respect that; an "Open path..." box does not. Needs a decision; the plan treats drives + recents as the baseline.
2. **PowerShell 7 preference.** Using `pwsh` when present changes the dialog style (Vista-style with address bar) between machines; acceptable, but the output contract and tests must cover both engines. The `WindowsApps` alias of `pwsh.exe` is a reparse point; `accessSync(X_OK)` works on it here but should be verified on a clean machine.
3. **Idle-timeout exemption** means a stuck dialog can hold a connection indefinitely; mitigate with the client-side Cancel and a 10-minute server cap.
4. **Drive enumeration** can touch slow network/removable drives; probe lazily per drive and never auto-expand.
5. **Windows hidden attribute** is not exposed by Node/Bun `Stats`; a name-based list is a heuristic. A tiny native call via PowerShell is too slow (see timings); consider `Bun.spawn("attrib")` only when the user toggles "show hidden".
6. **The user's actual install path** is unknown: repo `dist/` is 0.7.1 (no picker), so they are presumably on a newer npm package. The published `server.js` should be checked to confirm it carries the same `AutoUpgradeEnabled` line; the fix must go out as a release.
7. **Theme unification** risks subtle TUI regressions (OpenTUI colour handling differs from CSS); do it with snapshot tests of `cliTheme`.
8. **Not verified:** that WinForms `ShowDialog` renders in front of the browser once the script runs (suspected D), and that `-NonInteractive` is harmless for `ShowDialog` (suspected E). Both need one manual Windows run after Fix 1.
9. **Measurements are from one machine** (Windows 11, Defender on, OneDrive present). PowerShell start times vary widely; the design assumes 2-20 s, not a fixed number.

---

## Appendix: probes used (scratchpad, not committed)

- `probe-fs.ts` / `bench-fs.ts`: Bun fs semantics and timings on NTFS (all sub-ms; realpath case-normalises; junctions report `isSymbolicLink()`; `C:\Users\<me>\Desktop` absent, Desktop lives in OneDrive).
- `probe-ps.ts`: known-folder PowerShell resolver 10.3-10.7 s cold with the route's minimal env; WinForms load 19.1 s.
- `probe-picker.ts`: picker script prologue under `powershell.exe` -> exit 1, `AutoUpgradeEnabled` error.
- `idle-probe.ts`: `Bun.serve({ idleTimeout: 3 })` closes a 6 s handler at ~4 s and aborts `req.signal`.
- `time-flow.ts` / `time-open.ts`: web-client timings for locations/open/entries/select (2-42 ms for Home paths; 2.7-3.8 s for PowerShell-backed locations; Projects 404).

External references consulted: OpenCode TUI docs (leader-key keybinds, `@` fuzzy file search, `tui.json`) at https://opencode.ai/docs/tui/ ; Microsoft `FileDialog.AutoUpgradeEnabled` (FileDialog only in .NET Framework) at https://msdn.microsoft.com/en-us/library/Bb516977 ; .NET API catalog showing `FolderBrowserDialog.AutoUpgradeEnabled` only in modern .NET at https://api.apireview.net/catalog/61f9e87cf4d061a36ee7ac3822a89efa .
