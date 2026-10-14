# UI improvement research (TUI + Web) and Windows project-traversal bug

Independent research pass, 2026-10-14, on Windows 11 / Bun 1.3.13. No source code was modified. Every
reproduction ran from a scratchpad outside the repo. Files are cited as `path:line`.

## 1. Summary

- **Windows bug, confirmed root cause.** On Windows the web UI's "Choose project" button always fails.
  The PowerShell script that opens the folder dialog sets `$dialog.AutoUpgradeEnabled = $true`
  (`apps/server/src/lib/native-directory-picker.ts:149`). That property does not exist on
  `System.Windows.Forms.FolderBrowserDialog` in Windows PowerShell 5.1 (.NET Framework). The script also
  runs with `$ErrorActionPreference = 'Stop'`, so it throws, exits with code 1, and no dialog appears. The
  server maps this to `native_picker_failed`, and the web app falls back to the "common locations" browser.
- **Why the fallback can't reach the project.** That browser only offers five known folders under the
  user profile (Desktop, Home, Documents, Downloads, Projects; `packages/ai/src/workspace-browser.ts:5-11`).
  It also refuses filesystem roots (`workspace-routes.ts:157`, `:760`). A project on `D:\` (for example
  `D:\Self-Project\lightcode`) or in `C:\dev` cannot be reached. On macOS the `osascript choose folder`
  dialog works, and projects usually live under `$HOME` anyway, so the bug never showed there.
- **Two more problems wait behind that fix:**
  - The server's 30 s idle timeout (`apps/server/src/index.ts:17`) is not waived for the long-poll
    `/workspaces/picker/open` request, and an abort kills the dialog.
  - Cold-starting PowerShell + WinForms took about 12–15 s here. When the dialog does open, it is neither
    foreground nor topmost (measured), so it can sit behind the browser.
- **Server-side traversal itself is fine on Windows.** Driving the real route code in-process over 259
  directories under `%USERPROFILE%`, including OneDrive-redirected Desktop/Documents, produced only 2
  genuine ACL denials. I found no separator, drive-letter, case or realpath defect in browse/select.
- **UI in general.** Both surfaces share one coherent charcoal/amber design language, which is good. The
  biggest weaknesses:
  - TUI: vertical chrome eats space, keyboard/focus logic is overloaded inside a 1,788-line
    `chat-screen.tsx`, the IDE layout is fixed, and there are too many hint lines.
  - Web: no file/changes/diff view at all (the TUI has one), tool calls render as raw JSON, the project
    chooser is a dead end on Windows, dark-only theme, and no visible context/cost/todo state.

## 2. Current UI map

### 2.1 TUI (`apps/cli`, OpenTUI React)

| Area | File(s) | Notes |
| --- | --- | --- |
| Entry / mode switch | `apps/cli/src/index.tsx` | `lightcode` → TUI; `lightcode web [--no-open]` → spawns authenticated server and opens browser (`index.tsx:19-43`) |
| App frame | `apps/cli/src/app.tsx:463-575` | Header bar (status dot, "Lightcode", provider · model, current view), routed body with `padding={1}`, footer with hints + `ctx %` + cost. Palette, slash menu, help overlays positioned absolutely. |
| Routes | `apps/cli/src/navigation/route-registry.ts` | home, status, doctor, permissions, sessions, tools, config, connect, model, model-info, latest |
| Screens | `apps/cli/src/screens/*` | `home-screen.tsx` (24 lines, delegates to `home-text-area`), `chat-screen.tsx` (1,788 lines), `session-list-screen.tsx` (548), `diagnostics-screen.tsx` (472), `onboarding-screen.tsx`, `model-screen.tsx`, `model-select-screen.tsx` |
| Chat column | `components/chat/chat-shell.tsx` | Header "Conversation · N messages", bordered inset scrollbox (sticky bottom), error part, input area |
| Message parts | `chat-message*.tsx`, `chat-diff-card.tsx`, `chat-todo-status-card.tsx`, `chat-context-summary-card.tsx`, `chat-tool-approval-card.tsx`, `chat-interaction-popup.tsx`, `chat-proposed-plan-card.tsx` | Rich: diffs, todos, context cards, approvals, plan confirmation |
| IDE layout (F2) | `components/chat/ide-layout.tsx` | Tab bar (Terminal / IDE), Explorer 22% · Editor flex · Chat 34%, VS Code-style status bar. Only shown when terminal ≥ 100 cols (`chat-screen.tsx:557-560`) |
| Explorer / Changes / Editor | `components/chat/file-explorer-panel.tsx` (1,144 lines), `use-file-tree.ts`, `use-git-changes.ts`, `use-file-content.ts`, `file-editor.tsx`, `breadcrumb.tsx` | File tree reads the local FS via `@lightcode/ai/runtime`; git changes; read-only viewer + edit mode (`e`, Ctrl+S) |
| Overlays | `commands/command-palette.tsx`, `commands/slash-page-menu.tsx`, `components/help-overlay.tsx`, `copy-mode-overlay.tsx`, `permission-mode-selector.tsx`, `model-selector.tsx` | |
| Keymap | `commands/keymap.ts` | `/`, Ctrl+P, Ctrl+G, Ctrl+C/Q, F1, Ctrl+/, F2, Ctrl+O, Ctrl+R; screen-local keys in `chat-screen.tsx:1138-1381` |
| Theme | `ui/cli-theme.ts`, `ui/cli-theme-capabilities.ts`, `ui/components/badge.tsx`, `status-dot.tsx` | Single dark palette mirroring web tokens; typography roles (`typeRole`); NO_COLOR / non-UTF-8 fallbacks |

### 2.2 Web (`apps/web`, React 19, served by the Hono server)

| Area | File(s) | Notes |
| --- | --- | --- |
| Serving | `apps/server/src/routes/web-routes.ts` | `/app/*` static assets from `apps/web/dist` (source checkout) or `assets/web` (package); strict CSP; SPA fallback |
| Auth | `apps/server/src/lib/web-auth.ts`, `apps/cli/src/lib/web-launcher.ts` | Token passed via URL fragment from a private temp bootstrap HTML; stored in `sessionStorage` |
| Shell | `apps/web/src/app.tsx` (681 lines) | `SessionRail` (280px) + `main` (ChatSurface or NewSessionSurface) + modal `ProjectBrowser` + `ModelPicker`; Ctrl/Cmd+Shift+N, Ctrl/Cmd+K |
| Session rail | `components/session-rail.tsx` | New session, project button (native picker), search, flat session list, footer tagline |
| Chat | `components/chat-surface.tsx`, `chat-message.tsx`, `message-markdown.tsx` | GFM Markdown, grouped completed tools, approval dock, user prompts, back-to-latest |
| Composer + controls | `components/command-composer.tsx`, `workspace-ribbon.tsx`, `slash-command-menu.tsx`, `lib/slash-command-registry.ts`, `lib/web-command-executor.ts` | Model/mode/access selectors in composer row; folder-name button below |
| Project chooser | `components/project-browser.tsx` (685), `lib/workspace-location.ts`, `lib/exclusive-request-gate.ts` | Native-first (`POST /workspaces/picker/open`), bounded fallback browser (`/workspaces/locations`, `/browser/open`, `/browser/:id/entries`, `/browser/:id/select`) |
| API client | `lib/api.ts` (782) | Zod-parsed responses; `LightcodeApiError` |
| Styling | `styles.css` (2,412 lines), `DESIGN.md` | Tokens on `:root` (dark only). Breakpoints 400/460/760/980/1100; three separate `max-width: 760px` blocks (`styles.css:1620`, `:2050`, `:2389`) |

### 2.3 Server routes relevant to UI

`/sessions/*` (`chat-routes.ts`), `/config/*`, `/diagnostics/*`, `/extensions/*`, `/workspaces/*`
(`workspace-routes.ts`, 1,640 lines), `/app/*`. There are **no** routes for a session's file tree,
file content or git changes. The TUI reads those straight from the local FS, so the web cannot show them.

## 3. UX problems (prioritized, with evidence)

### P0: blocking

1. **Windows: no way to open a project outside the user profile from the web UI** (see §4). The
   native picker always fails, and the fallback cannot reach `D:\…`. The fallback notice then tells
   the user to "choose a project from a common location", which is impossible for this layout
   (`apps/web/src/app.tsx:96-102`).
2. **The "Projects" location is shown even when `~/Projects` doesn't exist, and opening it gives a
   misleading error.** `resolveProjectsDirectoryPath` falls back to a non-existent path
   (`workspace-routes.ts:609`). ENOENT then maps to "The selected folder is no longer available."
   (`:643`). Reproduced: `OPEN projects 404 workspace_missing`.

### P1: high impact

3. **TUI vertical space.**
   - App chrome alone costs ~8 rows: header with `paddingTop/Bottom` (`app.tsx:463-498`), body
     `padding={1}` (`:501`), footer `paddingY={1}` (`:547-575`).
   - ChatShell then adds a header row + gap + card border + scrollbox `paddingY` + gap
     (`chat-shell.tsx:34-97`).
   - IDE mode stacks a tab bar, a top padding row and a status bar on top of that
     (`ide-layout.tsx:112-150`).
   - On a 30–35 row terminal the transcript gets well under half the screen.
4. **Hint overload / duplicated status in the TUI.** Up to four simultaneous hint strings:
   - app footer (`app.tsx:450-461`)
   - text-area footer (`chat-screen.tsx:1434-1462`)
   - IDE tab bar "F2 exit IDE" (`ide-layout.tsx:127`)
   - IDE status bar

   Mode/permission appear in both the composer footer and the status bar (handled by hiding one,
   `chat-screen.tsx:1466-1468`). "Conversation · N messages" (`chat-shell.tsx:36-43`) uses a whole row
   for low-value info, while the session title, cwd/project and branch are missing outside IDE mode.
5. **Keyboard model is overloaded and hard to learn.**
   - Tab means "cycle mode" without the panel, "focus explorer" with the panel, and "switch
     Files/Changes" inside the panel. There is no Tab back to chat: you have to press Esc
     (`chat-screen.tsx:1185-1197`, `:1366-1373`).
   - All modal precedence is hand-coded through booleans in one `useKeyboard`
     (`chat-screen.tsx:1138-1381`) plus a second global handler (`app.tsx` ~`:380-436`).
   - The editor pane can only take focus in edit mode, so you cannot scroll a long file from the
     keyboard in browse mode.
   - `Ctrl+/` and `Ctrl+Enter` are unreliable in many Windows terminals (conhost sends `^_`; Ctrl+Enter
     often equals Enter without win32-input/kitty protocol). This is suspected and needs a check in
     Windows Terminal and conhost.
6. **F2 silently does nothing below 100 columns.** It toggles state, but `panelVisible` requires
   `terminalWidth >= 100` (`chat-screen.tsx:557-560`), and the toggle button is hidden too (`:1412`).
   There is no notice.
7. **The IDE layout is rigid.** Fixed `22% / flex / 34%` widths with `minWidth` (`ide-layout.tsx:131-139`).
   You cannot resize, collapse a single pane, or zoom one pane to full screen.
8. **Web: no file/changes/diff view.** The TUI has Explorer + Changes + editor. The web, the "browser
   UI for the same agent", only shows chat. Reviewing what the agent changed means leaving the
   browser. The server has no endpoints for it (§2.3).
9. **Web: tool calls render as raw JSON.** `ToolPart` prints `stringifyPreview(part.input)` and
   `stringifyPreview(output)` in `<pre>` (`apps/web/src/components/chat-message.tsx:48-85`). Edits and
   writes get no diff, unlike `apps/cli/src/components/chat/chat-diff-card.tsx`.
10. **Web: no context/cost/todo surface.** The TUI shows `ctx %`, compaction count, session cost
    (`app.tsx:559-575`) and a todo card. The web has none of these in persistent UI.

### P2: polish and consistency

11. **Project chooser UX on Windows.**
    - Home lists ten legacy junctions ("Application Data", "My Documents", "NetHood"…) as disabled
      "linked folder" rows (reproduced).
    - `fs.access(R_OK|X_OK)` on Windows doesn't evaluate ACLs, so rows like `.codex/app-server-control`
      show as enterable and then fail with 403 (reproduced).
    - Hidden detection is dot-prefix only (`workspace-routes.ts:1486`), so Windows `FILE_ATTRIBUTE_HIDDEN`
      items (`NTUSER.DAT*`, `AppData`) are always shown.
    - There is no typed path / filter / sort, and no "recent projects".
12. **Web session rail is flat.** Search only, no grouping by project, and pathLabel/cwd shown
    inconsistently: `"Downloads/foo"` for browser grants vs a full host path for native grants
    (`workspace-routes.ts:1353` vs `:1576-1579`).
13. **Web is dark-only.** Tokens live only on `:root` (`styles.css:13-29`), with no
    `prefers-color-scheme` handling. TUI colors are hard-coded hex (`cli-theme.ts`). There is no light
    variant on either surface, and on a light terminal background the panel/inset colors read as
    blocks.
14. **CSS has accreted.** Three `max-width: 760px` blocks plus 400/460/980/1100 breakpoints in one
    2,412-line file make regressions likely. Refactoring into component-scoped files would help.
15. **Component coupling.** `ide-layout.tsx:6` imports `TabButton` from the 1,144-line
    `file-explorer-panel.tsx`. `chat-screen.tsx` owns IDE, explorer, editor, copy-mode, approvals and
    plan state.
16. **Help overlay** is a static two-column dump (`help-overlay.tsx:4-10`). It isn't contextual or
    searchable, and it drifts from the actual bindings (hints are hand-written strings).

## 4. Windows traversal bug: root cause analysis

### 4.1 Full path

```
Web: "Choose project" (session-rail / workspace-ribbon) ─► app.tsx openNativeProjectPicker (:354-400)
  └─► api.openWorkspacePicker() POST /workspaces/picker/open           (api.ts:502-509)
        └─► workspace-routes.ts:1316-1365  nativeDirectoryPicker.pick(c.req.raw.signal)
              └─► native-directory-picker.ts resolvePickerCommand (win32: powershell.exe -STA -EncodedCommand <script>)
                    └─► windowsPickerScript (:142-171)  ── THROWS at line 8 ($dialog.AutoUpgradeEnabled)
              ◄── exit 1 → parseWindowsResult → NativeDirectoryPickerError("native_picker_failed") (:219-224)
        ◄── 500 {code:"native_picker_failed"}                          (mapNativePickerError :665-700)
  └─► catch → nativePickerFallbackNotice → "The system folder picker did not open" + setIsBrowserOpen(true) (app.tsx:389-396, :96-102)
        └─► ProjectBrowser: GET /workspaces/locations → 5 known folders (no drives, no cwd, no recents)
              └─► D:\Self-Project\lightcode unreachable by construction
```

### 4.2 Confirmed: the native picker script throws on Windows PowerShell 5.1

Evidence: I ran the exact argv built by `createNativeDirectoryPicker()` on this machine. Exit code 1
after 12.5 s, stdout empty, stderr:

```
The property 'AutoUpgradeEnabled' cannot be found on this object. Verify that the property exists and can be set.
At line:8 char:1
+ $dialog.AutoUpgradeEnabled = $true
```

- Source: `apps/server/src/lib/native-directory-picker.ts:149`, introduced in `1a3f934` (v0.16.0).
  `AutoUpgradeEnabled` exists on `FileDialog`. `FolderBrowserDialog` only gained it in .NET Core 3.0+, and
  the picker deliberately pins `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
  (`:306-319`), which is .NET Framework.
- Unit tests stub `runProcess` (`native-directory-picker.test.ts:24-101`), so the real script never
  ran in CI. Tests that touch real directories are `skipIf(win32)` (`workspace-routes.test.ts:798, 856, 975`).
- Control experiment: the same script with only that line removed opens a visible "Browse For Folder"
  window after ~15 s.

### 4.3 Confirmed: the fallback cannot reach non-profile locations

- Location ids are a closed enum of five profile folders (`packages/ai/src/workspace-browser.ts:5-11`;
  definitions at `workspace-routes.ts:1182-1239`).
- Filesystem roots (`C:\`, `D:\`, UNC share roots) are rejected as locations
  (`isFilesystemRootPath` `:157-164`, `normalizeKnownFolderCandidate` `:166-182`, `resolveKnownDirectory`
  `:756-764`).
- Segments are plain names under the location root, so `..` and drive letters can't be expressed
  (`workspace-browser.ts:63-76`). This is intentional, per DESIGN.md: "Don't … accept browser-supplied
  arbitrary paths."
- Result: any project on another drive, in `C:\dev`, `C:\src`, `\\wsl$\…`, or another non-profile
  folder is unreachable.

### 4.4 Confirmed: the idle timeout kills the picker long-poll

- `Bun.serve({ idleTimeout: 30 })` (`apps/server/src/index.ts:17`, `:189-199`) only calls
  `bunServer.timeout(request, 0)` for `/sessions/:id/(chat|turns)` (`:20-27`, `:194-196`).
- I reproduced Bun's behavior with `idleTimeout: 2` and a 5 s handler. The handler's `request.signal`
  aborted, and the client got "socket connection was closed unexpectedly" after about 4 s.
- For the picker, the abort reaches `runNativePickerProcess`, which kills the dialog
  (`native-directory-picker.ts:105-115`), and `pick()` reports `cancelled` (`:429`). The browser gets a
  network error and shows the generic fallback.
- Once 4.2 is fixed, the user still has only about 15–45 s, minus the ~12–15 s cold start, to navigate
  a legacy tree dialog.
- This affects macOS too in principle; the modern macOS dialog is just faster to use.

### 4.5 Confirmed (measured), lower severity: the dialog is not foreground or topmost

Enumerating the picker process's windows (via `EnumWindows`) showed `title='Browse For Folder'
visible=True topmost=False foreground=False`. The server is a background process, so Windows'
foreground lock stops it taking focus. The owner form has `ShowInTaskbar=false`
(`native-directory-picker.ts:150-156`), so the dialog can end up behind the browser with no taskbar
button. The legacy `FolderBrowserDialog` is also the old tree-view UI: no address bar, slow to reach
`D:\Self-Project\lightcode`.

### 4.6 Ruled out (tested, not the cause)

In-process runs of the real `workspace-routes.ts` (with only unrelated imports stubbed) showed:

- Opening all locations works; Desktop and Documents correctly resolve to OneDrive.
- Listing and entering 259 directories two levels deep under Home works.
- Selecting returns 201.
- `fs.realpath` normalises case (`c:\users\KMUGA\documents` → `C:\Users\kmuga\Documents`), and
  `path.relative`-based `isContainedPath` (`:741-749`) is case-insensitive on win32.
- dev/ino identity is stable between `stat` and `lstat`.
- Junctions are reported as symlinks, and `R_OK|X_OK` access passes.

None of the classic suspects (backslash splitting, `startsWith` containment, URL-encoded separators,
`file://` URLs) is involved: segments travel as JSON arrays, never as paths.

### 4.7 Fix design

Keep the security model: the browser never sends host paths, and the server only grants
server-derived or OS-dialog-derived paths.

**Fix A, hotfix (S).**
- Delete line 149. Optionally guard it:
  `if ($dialog | Get-Member -Name AutoUpgradeEnabled) { $dialog.AutoUpgradeEnabled = $true }`.
- Better: replace the WinForms tree dialog with the Vista `IFileOpenDialog` + `FOS_PICKFOLDERS` (modern
  Explorer dialog with address bar, drives and quick access), via a small inline C# `Add-Type`
  COM-interop class, keeping `FolderBrowserDialog` as a fallback when `Add-Type` fails (e.g.
  constrained language mode).
- Base64 output and `assertPickerPath` (`:190-213`) stay as they are.
- Acceptance:
  - Real Windows run: the dialog opens, choosing `D:\Self-Project\lightcode` returns
    `{outcome:"selected"}` and a 201 workspace grant.
  - Add a win32-only integration test (opt-in env, e.g. `LIGHTCODE_PICKER_SMOKE=1`) that runs the
    script with a parse-only/`-WhatIf`-style flag, or at least runs it through `powershell -Command
    { [scriptblock]::Create($s) }` to catch property errors.

**Fix B, idle timeout (S).**
- In `apps/server/src/index.ts` extend the exemption: `isChatStreamingRoute(request) ||
  isNativePickerRoute(request)` → `bunServer.timeout(request, 0)`. Alternatively give the picker its own
  10-minute cap (`AbortSignal.timeout`) so an orphaned dialog can't live forever.
- Acceptance: a picker held open for 2 minutes still returns `selected`. A browser tab closed mid-pick
  aborts and kills the dialog.

**Fix C, focus (S/M).**
- Bring the dialog forward: create the owner form, call `AllowSetForegroundWindow(ASFW_ANY)` from the
  server (or `SetForegroundWindow` + `AttachThreadInput` trick in the script), and set
  `ShowInTaskbar=$true` on the owner so it can be found.
- In the web UI, while `isPickingProject`, show "A folder dialog opened on your desktop — it may be
  behind this window" plus a Cancel button that aborts the fetch.
- Acceptance: the dialog is foreground (EnumWindows check), and Cancel aborts and the process exits.

**Fix D, server-owned locations beyond the profile (M).** Extend `workspaceLocationIdSchema` from a
closed enum to typed ids the server mints:
- `launch-cwd`: `lightcode web` passes `process.cwd()` to the spawned server (env such as
  `LIGHTCODE_WEB_INITIAL_CWD`, set in `apps/cli/src/lib/server-launcher.ts:287-296`). The web app
  pre-grants it, or offers it as the first location ("Open D:\Self-Project\lightcode"). This is the
  single biggest Windows UX win.
- `recent:<hash>`: distinct `cwd`s from stored sessions (`chat-store`). The browser sends only an
  opaque id, the server maps it to its own stored path, re-verifies identity, then grants it.
- `drive:<letter>` (win32 only): fixed/removable drives enumerated server-side (`fs.statfs`/`wmic`-free
  probe of `A-Z:\`). Roots are browsable but **not selectable**. Keep `isFilesystemRootPath` as a
  *selection* guard instead of a *location* guard, so users can descend into `D:\Self-Project`. Keep
  the broad-root confirmation.
- Acceptance:
  - On Windows, the browser lists "Current folder", "Recent projects", "Local Disk (C:)" and "Data
    (D:)".
  - Browsing `D:` → `Self-Project` → `lightcode` → "Use this folder" returns 201.
  - Selecting `D:\` itself is rejected with a clear message.
  - Existing segment-validation tests stay green, plus new win32-path unit tests run cross-platform with
    `path.win32`.

**Fix E, honest states (S).**
- Probe Projects lazily but hide or label it "Not found" instead of a 404 retry loop. Map ENOENT on
  `browser/open` to `location_not_found` with "~/Projects doesn't exist".
- On win32, mark entries with the `FILE_ATTRIBUTE_HIDDEN`/`SYSTEM` attribute as hidden (read via
  `fs.stat` + a small `attrib`-free check, or treat reparse-point junction names as hidden).
- Acceptance: Home on Windows shows no junction rows unless "Show hidden" is on.

**Fix F, fallback copy (S).** When the native picker failed, the notice should say what the fallback
can and cannot reach and offer "Use current folder" (launch-cwd) directly.

## 5. Improvement plan (phased)

Effort: S ≤ ½ day, M 1–3 days, L ≥ 1 week. Every item keeps `bun run typecheck` and `bun test` green.

### Phase 0: Windows unblock (ship first)

| # | Item | Files | Effort | Acceptance |
| --- | --- | --- | --- | --- |
| 0.1 | Remove/guard `AutoUpgradeEnabled`; add a win32 smoke test of the real script | `apps/server/src/lib/native-directory-picker.ts`, `native-directory-picker.test.ts` | S | §4.7 A |
| 0.2 | Exempt `/workspaces/picker/open` from idle timeout, plus a hard picker cap | `apps/server/src/index.ts` | S | §4.7 B |
| 0.3 | `launch-cwd` location / auto-grant from `lightcode web` | `apps/cli/src/lib/server-launcher.ts`, `apps/cli/src/index.tsx`, `apps/server/src/routes/workspace-routes.ts`, `packages/ai/src/workspace-browser.ts`, `apps/web/src/app.tsx` | M | Running `lightcode web` from `D:\Self-Project\lightcode` opens the web UI with that project selected, or one click away |
| 0.4 | Picker pending UI: "dialog may be behind this window" + Cancel | `apps/web/src/app.tsx`, `workspace-ribbon.tsx`, `session-rail.tsx` | S | Cancel aborts the request and the dialog process exits |

### Phase 1: TUI

| # | Item | Files | Effort | Acceptance |
| --- | --- | --- | --- | --- |
| 1.1 | **Reclaim vertical space.** Single-row header (no paddingY), merge footer hints into one status line, drop body padding, replace "Conversation · N messages" with a one-line session header (title · project · branch) | `apps/cli/src/app.tsx`, `components/chat/chat-shell.tsx` | S | On a 30-row terminal the transcript gains ≥ 5 rows. No information lost (moved, not removed) |
| 1.2 | **One hint line policy.** A single contextual hint slot owned by the focused region; app footer shows only global state (ctx %, cost, run state) | `app.tsx`, `chat-screen.tsx`, `ide-layout.tsx` | M | Never more than one hint string visible; Ctrl+P/F1 always discoverable |
| 1.3 | **Focus manager.** Extract a `useFocusRegions` (chat / explorer / editor / overlay stack) with explicit precedence; Tab and Shift+Tab cycle regions, Ctrl+T cycles mode everywhere, Esc pops overlays only | new `apps/cli/src/state/focus-regions.ts`, `chat-screen.tsx`, `app.tsx`, `commands/keymap.ts` | M | Tab always moves forward, including back to chat; key precedence unit tests for each overlay |
| 1.4 | **Split `chat-screen.tsx`.** Move IDE composition to `screens/chat/ide-workspace.tsx`, keyboard to `use-chat-keyboard.ts`, overlays to `chat-overlays.tsx`; move `TabButton` to `ui/components/tab-button.tsx`; split `file-explorer-panel.tsx` into `explorer-tree.tsx`, `changes-tab.tsx`, `editor-pane.tsx` | `apps/cli/src/screens/chat-screen.tsx`, `components/chat/file-explorer-panel.tsx`, `ide-layout.tsx` | L | No file > ~600 lines; behavior unchanged (existing tests pass); kebab-case filenames per AGENTS.md |
| 1.5 | **Adaptive IDE.** Below 100 cols F2 opens a single-pane *drawer* (Explorer or Changes over chat) instead of doing nothing; ≥ 100 cols allow `Ctrl+←/→` pane resize and `z` zoom of the focused pane; remember widths per session | `ide-layout.tsx`, `chat-screen.tsx`, `state/app-state.tsx` | M | F2 always does something visible; resize persists while running |
| 1.6 | **Editor browse focus.** Editor pane focusable in browse mode (PgUp/PgDn, g/G, `/` find) | `file-explorer-panel.tsx` (editor-pane), `use-file-content.ts` | M | Scroll a 2,000-line file without entering edit mode |
| 1.7 | **Contextual help.** Generate the help overlay from the keymap plus region bindings; filterable; show the current region first | `components/help-overlay.tsx`, `commands/keymap.ts` | S | Help content equals the registered bindings (test) |
| 1.8 | **Windows terminal key audit.** Detect when Ctrl+Enter or Ctrl+/ can't be distinguished; offer Alt+Enter / Shift+Enter newline and F1 as primary; document in help | `components/chat/chat-text-area.tsx`, `utils/key-utils.ts`, `help-overlay.tsx` | S | Manual check in Windows Terminal + conhost: newline and help work |
| 1.9 | **Light-terminal variant.** Add a `light` palette and `LIGHTCODE_THEME=auto\|dark\|light` (auto via COLORFGBG/OSC 11 when available) | `ui/cli-theme.ts`, `ui/cli-theme-capabilities.ts` | M | Readable on light Windows Terminal schemes; NO_COLOR unchanged |

### Phase 2: Web

| # | Item | Files | Effort | Acceptance |
| --- | --- | --- | --- | --- |
| 2.1 | **Project chooser rework.** Sections: Current folder (launch-cwd), Recent projects (from sessions), Drives (win32), Common locations. Type-to-filter in the folder list, keyboard ↑/↓/Enter/Backspace navigation, Windows hidden filtering, "Not found" locations greyed | `components/project-browser.tsx`, `lib/api.ts`, `lib/workspace-location.ts`, `styles.css` | M | Reach `D:\Self-Project\lightcode` in ≤ 4 keystrokes after opening; Axe has no violations in the dialog |
| 2.2 | **Tool-call rendering.** Per-tool renderers: edit/write → unified diff (reuse the TUI diff model in shared), bash → command + exit code + collapsible output, read/grep/glob → path chips plus counts; raw JSON only behind "Details" | `components/chat-message.tsx`, new `components/tool-parts/*.tsx`, `packages/shared` (diff model) | M | Edit tool shows +/- lines; no raw JSON visible by default |
| 2.3 | **Changes panel (web parity with TUI F2).** Right-side collapsible panel: Changes (git status + per-file diff), Files (lazy tree), file viewer read-only | `apps/web/src/components/changes-panel.tsx` (new), `app.tsx`, `styles.css`, server routes in Phase 3 | L | Toggle with Ctrl/Cmd+B and a header button; ≥ 1100px side panel, < 1100px overlay drawer; updates live after each tool result |
| 2.4 | **Run status strip.** Compact context %, compaction count, cost and a todo progress popover in the composer toolbar (mirrors the TUI footer) | `components/command-composer.tsx`, `chat-surface.tsx`, `lib/api.ts` (`getContext` already exists) | S | Values match the TUI for the same session |
| 2.5 | **Session rail grouping.** Group by project (pathLabel/cwd basename), pin current project, consistent path labels (host path in a tooltip for both grant kinds) | `components/session-rail.tsx`, `workspace-routes.ts` (`pathLabel` for browser grants) | S | Sessions from TUI and web for the same folder appear in one group |
| 2.6 | **Keyboard shortcuts sheet.** `?` opens a shortcuts dialog; add Ctrl/Cmd+B (panel), Ctrl/Cmd+. (stop run), Ctrl/Cmd+O (open project) | `app.tsx`, new `components/shortcuts-dialog.tsx` | S | All shortcuts listed and working on Windows (Ctrl) and macOS (Cmd) |
| 2.7 | **Light theme.** Redefine tokens under `@media (prefers-color-scheme: light)` + manual toggle (persist in localStorage, try/catch) | `styles.css`, `DESIGN.md`, `app.tsx` | M | WCAG AA contrast for text tokens in both themes |
| 2.8 | **CSS consolidation.** Split `styles.css` into per-component files imported by the build, one breakpoint section per component, remove duplicate 760px blocks | `apps/web/src/styles/*.css`, `scripts/build.ts` | M | No visual diff at 1440/1100/760/390/320 (screenshot compare) |

### Phase 3: shared / server

| # | Item | Files | Effort | Acceptance |
| --- | --- | --- | --- | --- |
| 3.1 | **Workspace location model v2:** `launch-cwd`, `recent:<id>`, `drive:<X>`; roots browsable but not selectable | `packages/ai/src/workspace-browser.ts`, `apps/server/src/routes/workspace-routes.ts`, tests | M | §4.7 D; cross-platform unit tests using `path.win32` |
| 3.2 | **Session file/changes API**, bounded by the session cwd using `resolve-within-workspace`: `GET /sessions/:id/tree?segments=`, `GET /sessions/:id/file?segments=`, `GET /sessions/:id/changes`, `GET /sessions/:id/changes/:fileId/diff` | `apps/server/src/routes/session-files-routes.ts` (new), `apps/server/src/app.ts`, reuse `packages/ai/src/git/runtime.ts` | M | Path traversal and symlink-escape tests; Windows backslash/case tests; size caps; binary detection |
| 3.3 | **Shared presentation model.** Move diff hunking, tool-summary text (target/verb), mode/permission labels and status wording into `packages/shared` so TUI and web say the same things | `packages/shared/src/*`, CLI `chat-message-tool-invocation-part.tsx`, web `chat-message.tsx` | M | One source for labels; snapshot tests on both renderers |
| 3.4 | **Design tokens single source.** Generate `cli-theme.ts` colors and the web `:root` tokens from one `packages/shared/src/design-tokens.ts` | `packages/shared`, `apps/cli/src/ui/cli-theme.ts`, `apps/web/src/styles.css` (or a generated `tokens.css`) | S | Changing a token updates both surfaces |
| 3.5 | **Windows CI lane** that runs picker script parsing and workspace route tests that are currently `skipIf(win32)`, with win32-specific expectations | CI config (none yet), tests | M | Regressions like §4.2 fail CI |

## 6. External patterns worth borrowing

These come from general knowledge of the tools, not fetched docs.

- **OpenCode / Codex CLI / Claude Code (TUIs):**
  - Transcript-first.
  - One status line (model · ctx · cost · mode).
  - Edits as inline diffs.
  - A single leader/help key that lists contextual bindings.
  - Approvals inline with explicit "once / always / deny".
  - Minimal persistent chrome.
- **Zed / Cursor agent panels:**
  - A "review changes" multi-file diff with per-file accept/revert.
  - Context chips showing which files are in play.
  - A collapsible side panel rather than a fixed 3-pane IDE.
- **VS Code-style browsers / Windows apps:** the modern `IFileOpenDialog` folder picker, and
  "Recent" + "This PC" drive entries as the default project chooser on Windows.

## 7. Risks and open questions

- **Security posture vs reachability.** Adding drives and recent projects widens what the browser
  can enumerate. Mitigations:
  - Server-minted ids only.
  - Roots non-selectable.
  - Broad-root confirmation.
  - Capability TTL.
  - The existing `web-auth` token.

  Product decision needed: should drive roots be *browsable* or only reachable through launch-cwd and
  recents?
- **IFileOpenDialog via `Add-Type`** compiles C# at runtime (~1–2 s extra, blocked under Constrained
  Language Mode / some EDR). Keep the WinForms fallback, or ship a tiny prebuilt helper. The
  "corporate laptop" reliability bar argues for keeping a fallback path.
- **PowerShell cold start** measured 12–15 s on this machine ("Preparing modules for first use"). Pre-warming
  a picker process when the web UI loads would cut latency but spawns a process speculatively.
- **The foreground lock** may still block focus. The UI hint (0.4) is the reliable mitigation.
- **Web Changes panel (2.3)** needs Phase 3.2 endpoints. Watch for file-content exposure: cap sizes and
  respect `.gitignore`/secret-file rules shared with the agent's read tool.
- **Terminal key detection (1.8)** varies across Windows Terminal, conhost, VS Code terminal and
  ConPTY. Manual verification is required; behavior cannot be fully unit tested.
- **Large refactors (1.4, 2.8)** carry merge-conflict risk with ongoing feature work. Do them in
  isolated PRs with no behavior change.
- **Unverified:**
  - Whether `lightcode web` from the packaged `dist` (not source) hits the same PowerShell path. It
    should, since the same module is bundled.
  - Behavior on Windows with PowerShell 7 only, or with `powershell.exe` removed.
  - ARM64 Windows.
