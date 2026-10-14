# Lightcode UI improvement: final consolidated plan

Synthesis of `research-opus.md` and `research-fable.md` (both kept in this folder), dated 2026-10-14.
Key claims were spot-checked against the source; "verified" below means the synthesis pass re-read the
code or re-ran a probe, not just trusted a research note. No source code was changed.

Effort: **S** is half a day or less, **M** is 1-3 days, **L** is a week or more. Every item must keep
`bun run typecheck` and `bun test` green. (The root `package.json:16` does define `test`, even though
AGENTS.md says there are no test scripts. See "Risks".)

---

## 1. Executive summary

**What's wrong**
- **On Windows the web UI can't open most projects.**
  - The native folder picker always fails. Its PowerShell script sets a property that doesn't exist
    on .NET Framework (`native-directory-picker.ts:149`).
  - The fallback browser can only reach five folders inside the user profile, and it refuses drive
    roots. So `D:\Self-Project\lightcode` can't be reached at all.
  - macOS never shows the problem because `osascript choose folder` works.
- **Three more problems will appear once the first one is fixed:**
  - the 30 s HTTP idle timeout kills the dialog;
  - PowerShell/WinForms takes 9-19 s to start;
  - the dialog opens behind the browser with no taskbar button.
- **The UI in general:**
  - The TUI wastes vertical space and spreads hints across several places. Its focus and keyboard
    logic lives in a 1,788-line `chat-screen.tsx`, and the IDE layout is fixed.
  - The web UI can't show files, changes or diffs, shows tool calls as raw JSON, and has no
    context, cost or todo state.

**What we'll do, in order**
1. **Phase 0: Windows unblock.** One short release with five parts: fix the picker script, exempt
   the picker from the idle timeout, give the dialog a taskbar presence, show pending progress with
   a Cancel button, and add a one-click "Open launch folder". Add a test that runs the real script
   on win32.
2. **Phase 1: project access model.** Add recent projects and a Drives location, cache known folders,
   label missing locations honestly, and filter Windows clutter from listings.
3. **Phase 2 (TUI) and Phase 3 (web)** can run as parallel streams after Phase 1. Server APIs that the
   web needs come first in **Phase 4 (shared/server)**; items 4.1 and 4.2 are prerequisites of 3.4.
4. **Deferred:** an "Open path..." box (needs a product decision), the `IFileOpenDialog` picker, a
   leader key, and an activity rail.

---

## 2. Windows web-UI traversal bug (Phase 0, highest priority)

### 2.1 Consolidated root cause

| # | Finding | Status | Evidence |
| --- | --- | --- | --- |
| A | Picker script throws on `$dialog.AutoUpgradeEnabled = $true`. `$ErrorActionPreference='Stop'` makes it exit 1, which maps to `native_picker_failed`, then the web shows the fallback | **Confirmed** by both plans, and **verified again** in this pass. Reflection on `powershell.exe` 5.1 / CLR 4.0.30319 returned `FolderBrowserDialog.AutoUpgradeEnabled=False` and `FileDialog.AutoUpgradeEnabled=True`; `Add-Type` alone took 9.1 s | `apps/server/src/lib/native-directory-picker.ts:142-171` (script), `:149` (line), `:312-318` (pinned `WindowsPowerShell\v1.0\powershell.exe`), `:219-224` (exit≠0 maps to failed) |
| B | The fallback browser reaches only Desktop/Home/Documents/Downloads/Projects. Filesystem roots are rejected as locations. Segments are plain names | **Confirmed** (verified in code) | `packages/ai/src/workspace-browser.ts:5-11` (closed enum), `:63-72` (segment rules); `workspace-routes.ts:157-164` (`isFilesystemRootPath`), `:756-764` (`resolveKnownDirectory` rejects roots), `:1182-1239` (definitions) |
| C | `Bun.serve({ idleTimeout: 30 })` aborts the picker request. Abort kills the dialog, so the user gets a generic error | **Confirmed mechanism** (both plans ran an idle probe). The exemption covers only chat routes (verified) | `apps/server/src/index.ts:17,20-27,189-196`; kill on abort `native-directory-picker.ts:105-115`; `pick()` reports `cancelled` after abort (`:429`) |
| D | The dialog is visible but not foreground or topmost. The owner form is off-screen with `ShowInTaskbar=false`, so the dialog can hide behind the browser with no taskbar button | **Measured** by Opus (EnumWindows: `visible=True topmost=False foreground=False`). Fable only suspected it | `native-directory-picker.ts:150-160` |
| E | The failure is opaque: stderr is discarded, the copy is generic, and the web cannot cancel | **Confirmed** (verified). `parseWindowsResult` never reads `stderr`. `api.openWorkspacePicker()` takes no `AbortSignal`, and `api.ts` has no `signal` plumbing | `native-directory-picker.ts:215-224`; `apps/web/src/lib/api.ts:501-508`; `apps/web/src/app.tsx:96-102` |
| F | The known-folder PowerShell resolver has a 2 s kill timer that cold PowerShell never meets, so each Desktop/Documents/Downloads open costs 2-4 s and silently uses env fallbacks | **Confirmed** (Fable measured; timer verified) | `workspace-routes.ts:223-301`, timer at `:283` |
| G | `~/Projects` missing leads to 404 `workspace_missing` "The selected folder is no longer available." and a Retry that can never succeed | **Confirmed** (code verified; both reproduced) | `workspace-routes.ts:569-610` (returns `candidates[0]` even if absent), `:640-647` |
| H | Server-side path handling (realpath, `path.relative` containment, junctions, OneDrive, bigint inodes) is correct on NTFS | **Confirmed working** by both. Not a cause | `workspace-routes.ts:741-749` |
| I | `-NonInteractive` is harmless for `ShowDialog` | **Likely OK.** Opus's control run (property removed) opened a visible dialog with the same argv | `native-directory-picker.ts:325-330` |

### 2.2 Fix: step by step

Security model is unchanged throughout: the browser never sends a host path. The server grants only
paths it derived itself or that came back from the OS dialog.

**0.1 Fix the picker script (S)**: `apps/server/src/lib/native-directory-picker.ts`
1. Delete line 149 (`$dialog.AutoUpgradeEnabled = $true`).
   - Don't guard it. The picker deliberately runs only `powershell.exe` (.NET Framework), where the
     property never exists, so a guard would be dead code.
   - Don't add other modern-.NET-only `FolderBrowserDialog` members either, such as
     `UseDescriptionForTitle` or `InitialDirectory`. The new test catches them anyway.
2. Add a comment marker line `# lightcode:show-dialog` immediately before `try {` (current `:157`).
   The test cuts the script at this marker. Production behaviour is unchanged.
3. Give the dialog a findable presence:
   - Set `$owner.ShowInTaskbar = $true` and `$owner.Text = 'Lightcode - choose a project folder'`.
   - Move the owner from (-32000,-32000) to the primary screen's working-area centre. Keep it at
     1×1 px, `Opacity = 0`, `TopMost = $true`.
   - Keep `Show()` / `Activate()`. Activation stays best effort, because the Windows foreground lock
     may still refuse it.
4. Carry a diagnostic on failures:
   - Add an optional `diagnostic` field to `NativeDirectoryPickerError`: the first 500 chars of
     stderr, with control characters stripped.
   - Fill it in `parseWindowsResult` / `parseMacosResult` / `parseLinuxResult`.
   - Never return it in the HTTP body.

**0.2 Exempt the picker from the idle timeout, with a hard cap (S)**: `apps/server/src/index.ts`, new
`apps/server/src/lib/long-running-routes.ts`
1. Move `isChatStreamingRoute` into `long-running-routes.ts` as `isLongRunningRoute(request)`. It
   covers `POST /sessions/:id/(chat|turns)` and `POST /workspaces/picker/open`. `index.ts:194` calls it.
2. Extract the `fetch` wrapper into `createServerFetch(app)` in the same file, so a test can mount it
   on its own `Bun.serve` with a small `idleTimeout`.
3. In the picker route (`workspace-routes.ts:1336`), pass
   `AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10 * 60_000)])`. A closed tab still kills
   the dialog, and an orphaned dialog dies after 10 minutes.
4. Leave `/workspaces/browser/open` alone. Its PowerShell call is capped at 2 s (and cached by 1.3).
5. In `mapNativePickerError` (`workspace-routes.ts:665-700`), log at warn level with the code and
   `diagnostic`. A log line like `native_picker_failed ... AutoUpgradeEnabled` would have made this
   bug a one-minute diagnosis.

**0.3 Web pending state and Cancel (S)**: `apps/web/src/lib/api.ts`, `apps/web/src/app.tsx`,
`components/session-rail.tsx`, `components/workspace-ribbon.tsx`, `styles.css`
1. Add an optional `signal` to the `request` helper and to `openWorkspacePicker({ signal })`.
2. `openNativeProjectPicker` (`app.tsx:354-400`) holds an `AbortController` in a ref. An abort counts
   as a user cancel, so no fallback notice is shown.
3. While `isPickingProject`:
   - From the start, show "Opening the system folder dialog…" with a **Cancel** button.
   - After 3 s on Windows, add: "First launch can take up to ~20 s. The dialog may open behind this
     window; check the taskbar for 'Lightcode - choose a project folder'."
   - Detect the platform via `navigator.userAgentData?.platform ?? navigator.platform`. This is
     display copy only.
4. Rewrite the `native_picker_failed` copy (`app.tsx:96-102`):
   - Say the Windows dialog failed to start.
   - Say what the fallback can reach (folders in your user profile).
   - When item 0.4 reports a launch folder, offer **Open <launch folder>** as the primary action.

**0.4 One-click "Open launch folder" (M)**: `apps/cli/src/lib/server-launcher.ts`,
`apps/server/src/routes/workspace-routes.ts`, `packages/ai/src/workspace-browser.ts`,
`apps/web/src/lib/api.ts`, `apps/web/src/app.tsx`
1. In `startAuthenticatedWebServer` only (`server-launcher.ts:286-296`), add
   `LIGHTCODE_WEB_LAUNCH_CWD: process.cwd()` to the child env.
   - Verified: the spawn sets no `cwd`, so the server's `process.cwd()` already matches. The explicit
     variable is testable and survives future launcher changes.
2. The server parses the variable once with a zod schema: a string, absolute, no NUL. Then it runs
   `normalizeKnownFolderCandidate` (rejects filesystem roots).
3. Add two routes, with schemas in `workspace-browser.ts` and handlers using `zValidator` and
   `c.req.valid('json')`:
   - `GET /workspaces/launch-folder` returns `{ available: boolean, name?, pathLabel?, broad?: boolean }`.
     `broad` is true when the folder equals the home directory.
   - `POST /workspaces/launch-folder/grant` takes a strict `{}` body. It is allowed only for
     `isAuthenticatedWebRequest`. It re-runs `resolveKnownDirectory` and `storeWorkspaceGrant`
     exactly as the native picker branch does (`workspace-routes.ts:1342-1346`).
4. Web:
   - When no workspace is stored and the launch folder is available, the new-session surface shows
     **Open D:\Self-Project\lightcode** as the primary call to action, with the picker and browser as
     secondary.
   - It never auto-grants. A `broad` folder gets the existing "broad access" wording.
   - Parse the response with zod in `api.ts`.

### 2.3 Tests to add

| Test | File | What it proves |
| --- | --- | --- |
| **Real-script prologue on Windows** (the bar for this bug) | new `apps/server/src/lib/native-directory-picker.windows.test.ts` | Steps below the table. It runs the exact production script, flags and spawner up to `ShowDialog`, so any property, assembly or type error fails it. This class of bug cannot pass. |
| Static guard (all platforms) | `native-directory-picker.test.ts` | Decode the captured EncodedCommand and assert it contains `# lightcode:show-dialog` and none of `AutoUpgradeEnabled`, `UseDescriptionForTitle`, `InitialDirectory`. A cheap macOS/Linux tripwire. |
| Diagnostic captured, not leaked | `native-directory-picker.test.ts` and `workspace-routes.test.ts` | A stub runner returning exit 1 plus stderr gives an error whose `diagnostic` contains the stderr excerpt. The HTTP 500 body has only `code` and `error`. The logger spy sees the diagnostic. |
| Idle-timeout exemption | new `apps/server/src/lib/long-running-routes.test.ts` | Unit test of `isLongRunningRoute` (picker POST yes; GET picker, browser/open and other routes no). Integration test: `Bun.serve({ idleTimeout: 1, fetch: createServerFetch(stubApp) })`, with a stub `/workspaces/picker/open` handler that waits 2.5 s, returns 200. A stub on a non-exempt route closes the socket. About 3 s total. |
| Abort cap | `workspace-routes.test.ts` | An injected picker sees an aborted signal when the client aborts; the cap is passed (the signal is `AbortSignal.any`-composed). |
| Launch folder | `workspace-routes.test.ts` | Missing env gives `available:false`. Root path gives `available:false`. Valid temp dir: `GET` returns `name`/`pathLabel`, `POST` returns 201 with a grant whose `pathLabel` is the canonical root. Unauthenticated `POST` gives 403. A `{ path: "..." }` body gives 400 (strict schema). |
| Web cancel | `apps/web` tests next to `api.ts` / `app.tsx` | Aborting rejects with `AbortError`, which is treated as cancel; no fallback notice. |

Steps for the real-script prologue test:

1. Gate it with `test.skipIf(process.platform !== "win32")` and set a timeout of 90,000 ms.
2. Call `createNativeDirectoryPicker({ platform: "win32", runProcess: recording })` with the real
   `which` and real `SystemRoot`. The recording runner captures argv and returns `cancelled`.
3. Decode the `-EncodedCommand` argument (UTF-16LE base64).
4. Cut the script at `# lightcode:show-dialog` and append
   `[Console]::Out.Write('prologue-ok:' + [bool]$dialog + ':' + [bool]$owner)`.
5. Re-encode, swap it back into the same argv, and run it with the real `runNativePickerProcess`.
6. Assert `exitCode === 0`, `stdout === "prologue-ok:True:True"` and `stderr === ""`.

This test is **default-on for win32, not opt-in**. Both research plans proposed an opt-in env flag,
but opt-in smoke tests never run, which is how this bug shipped. Allow
`LIGHTCODE_SKIP_PICKER_SMOKE=1` for constrained machines.

### 2.4 Acceptance criteria (Phase 0)

1. The Windows prologue test passes on this machine under `bun test`, and fails if line 149 is
   restored.
2. **Manual check on Windows 11:**
   - Start `bun apps/cli/src/index.tsx web` from `D:\Self-Project\lightcode` and click Choose project.
   - The Lightcode dialog appears with a taskbar button within about 20 s cold, or about 3 s warm.
   - Choosing `D:\Self-Project\lightcode` returns 201 `{outcome:"selected"}`, and a new session's
     `cwd` is that path.
3. **Same run, slow user:** leaving the dialog open for 2 minutes and then selecting still succeeds,
   with no socket close.
4. **Cancel:** the web Cancel button, or closing the tab, makes the `powershell.exe` child exit
   within 2 s (check Task Manager or `Get-Process`).
5. **Native picker forced to fail** (stub `which` returns null, or rename via test seam): the
   new-session surface offers "Open D:\Self-Project\lightcode", and one click yields a grant.
6. A server log line names the failure cause for `native_picker_failed`.
7. Chat streaming idle behaviour is unchanged.

---

## 3. Consolidated UX problem list

De-duplicated across both plans. "Src" marks which plan found it: **O** (Opus), **F** (Fable), **B**
(both).

### P0: blocks a core flow
| # | Problem | Evidence | Src |
| --- | --- | --- | --- |
| 1 | Windows native picker always fails | §2.1 A | B |
| 2 | Fallback can't reach outside the profile (other drives, `C:\dev`, `\\wsl$`) | §2.1 B | B |
| 3 | Picker killed by 30 s idle timeout | §2.1 C | B |
| 4 | Picker failure is slow and opaque: 9-19 s spinner, generic copy, no cancel, stderr discarded | §2.1 E; `app.tsx:96-102` | B |

### P1: hurts daily use
| # | Problem | Evidence | Src |
| --- | --- | --- | --- |
| 5 | Web: "Projects" location shown when absent, with a misleading 404 and a dead Retry | §2.1 G | B |
| 6 | Web: dialog behind the browser, no taskbar button | §2.1 D | B (O measured) |
| 7 | Web: no launch-folder or recent-projects entry. Sessions already store `cwd` (`chat-store.ts:49,61`) but it isn't offered | `workspace-routes.ts:1367-1375` | B (launch folder: O) |
| 8 | Web: Windows noise in the folder list. Hidden is dot-prefix only, so `NTUSER.DAT*` and `desktop.ini` show. About 10 legacy junction rows; files listed though never actionable | `workspace-routes.ts:1486`; `api.ts:567-569`; `project-browser.tsx:576-582` | B |
| 9 | Web: known-folder resolution costs 2-4 s per open on Windows | §2.1 F | F |
| 10 | Web: no files/changes/diff surface, and the server has no routes for it (`apps/server/src/routes/` verified: no session-files route) | parity with TUI F2 | B |
| 11 | Web: tool calls shown as raw JSON `<pre>` for input and output; no diff for edits | `apps/web/src/components/chat-message.tsx:48-85` (verified) | O |
| 12 | Web: no persistent ctx %, compaction, cost or todo state (the TUI has them at `app.tsx:559-575`) | | O |
| 13 | Web: project chooser is a modal that makes main `inert`, including while the OS dialog is pending | `project-browser.tsx:377-415`, `app.tsx:474` | F |
| 14 | Web: path labels inconsistent. Native and launch grants show the full host path; browser grants show `Desktop/foo`, which is ambiguous with OneDrive redirection | `workspace-routes.ts:1342-1346` vs `:1548-1597` (verified) | B |
| 15 | TUI: about 8 rows of chrome before ChatShell's own header, border and padding; IDE mode adds 3 more | `app.tsx:463-575`, `chat-shell.tsx:34-97`, `ide-layout.tsx:112-150` | O |
| 16 | TUI: up to 4 hint strings at once, with mode and permission duplicated. Session title, project and branch are missing outside IDE mode | `app.tsx:450-461`, `chat-screen.tsx:1434-1468`, `ide-layout.tsx:127` | O |
| 17 | TUI: Tab is overloaded (cycles mode, focuses the explorer, switches tabs) and has no path back to chat. Precedence is hand-coded booleans in one `useKeyboard` | `chat-screen.tsx:1138-1381`, Tab at `:1370-1377` (verified) | B |
| 18 | TUI: F2 silently does nothing below 100 columns | `chat-screen.tsx:557-560` (verified) | O |
| 19 | TUI: IDE layout fixed at 22% / flex / 34%; no resize, collapse or zoom | `ide-layout.tsx:131-139` | B |
| 20 | TUI: `chat-screen.tsx` is 1,788 lines (verified) and owns everything; `file-explorer-panel.tsx` is 1,144 | | B |
| 21 | TUI: messages are wall-of-cards; every message is a bordered card | `chat-message.tsx:127-132` | F |

### P2: polish and consistency
| # | Problem | Evidence | Src |
| --- | --- | --- | --- |
| 22 | TUI help: global bindings come from `keymap`, but context hints are hand-written strings that drift. The chat-local keys (`[`/`]`, `d`, `w`, `r`, Ctrl+Y…) are only partly listed | `help-overlay.tsx:4-10` (verified) | B |
| 23 | TUI: `Ctrl+/` and `Ctrl+Enter` may be unreliable in conhost and some Windows terminals | **suspected**, needs a manual check | O |
| 24 | TUI: editor pane can't take focus in browse mode, so you can't scroll a long file | | O |
| 25 | TUI: home screen is decoration only (no recent sessions or quick actions) | `home-screen.tsx` | F |
| 26 | TUI: editor tab strip clips at 8 tabs; no unsaved-changes guard on close | `file-explorer-panel.tsx:766-803` | F |
| 27 | Web: dark-only, no `prefers-color-scheme` (verified: no match in `styles.css`). Tokens duplicated by hand with the TUI's `cli-theme.ts` | `styles.css:13-29` | B |
| 28 | Web: `styles.css` is 2,412 lines with three separate `max-width: 760px` blocks | `styles.css:1620,2050,2389` | O |
| 29 | Web: session rail is flat, with no grouping by project | `session-rail.tsx` | O |
| 30 | Web: shortcut glyphs `⇧ N` and `⌘ K` shown on Windows | `session-rail.tsx:71,86` | F |
| 31 | Web: provider status pill is visible only before a session exists | `workspace-ribbon.tsx:111` | F |
| 32 | Both: empty and loading states are inconsistent; the folder list isn't virtualised | `file-explorer-panel.tsx:362-369`; `project-browser.tsx` | F |

---

## 4. Phased roadmap

### Phase 0: Windows unblock (one release)

| # | Item | Files | Effort | Deps | Acceptance |
| --- | --- | --- | --- | --- | --- |
| 0.1 | Fix picker script, give the dialog taskbar presence, carry `diagnostic` | `apps/server/src/lib/native-directory-picker.ts`, `.test.ts`, new `native-directory-picker.windows.test.ts` | S | none | §2.4 #1, #2, #6 |
| 0.2 | `isLongRunningRoute` + `createServerFetch`; 10-min picker cap; warn log | `apps/server/src/index.ts`, new `apps/server/src/lib/long-running-routes.ts` + test, `workspace-routes.ts` | S | none | §2.4 #3, #7 |
| 0.3 | Pending copy + Cancel + honest failure copy | `apps/web/src/lib/api.ts`, `app.tsx`, `components/session-rail.tsx`, `components/workspace-ribbon.tsx`, `styles.css` | S | 0.2 (cancel relies on signal kill) | §2.4 #4 |
| 0.4 | Launch-folder routes + CTA | `apps/cli/src/lib/server-launcher.ts`, `packages/ai/src/workspace-browser.ts`, `workspace-routes.ts`, `apps/web/src/lib/api.ts`, `app.tsx` | M | none | §2.4 #5 |

### Phase 1: project access model (web + server)

| # | Item | Files | Effort | Deps | Acceptance |
| --- | --- | --- | --- | --- | --- |
| 1.1 | **Recent projects.** Add `GET /workspaces/recent`, which returns server-minted opaque keys plus name/pathLabel/lastUsed from distinct session `cwd`s. Add `POST /workspaces/recent/:key/grant`, which re-canonicalises, re-checks identity and rejects roots. Shown in the rail and the chooser | `apps/server/src/lib/chat-store.ts` (distinct cwd query), `workspace-routes.ts`, `packages/ai/src/workspace-browser.ts`, `apps/web/src/lib/api.ts`, `components/session-rail.tsx`, `components/project-browser.tsx` | M | 0.4 (shares the grant helper) | A project used from the TUI appears in the web and opens with one click. A deleted folder shows "Unavailable". The key is not a path; a tampered key gives 404 |
| 1.2 | **Drives location (win32).** Add a location kind `drives`. The server enumerates `A:`-`Z:` with `fs.stat` lazily and never auto-expands network drives. The first segment must match a server-listed drive token (validated explicitly, since segments only reject `\0 / \` and dot names). `isFilesystemRootPath` becomes a *selection* guard, not a *location* guard. The broad-root confirmation stays | `packages/ai/src/workspace-browser.ts`, `workspace-routes.ts` (`:157-182`, `:756-764`, entries/select), `components/project-browser.tsx`, `lib/workspace-location.ts` | M | none | On Windows, Drives → `D:` → `Self-Project` → `lightcode` → "Use this folder" returns 201. Selecting `D:\` is rejected with clear copy. Existing segment tests stay green. New `path.win32` unit tests run cross-platform |
| 1.3 | **Known-folder cache.** Resolve Desktop/Documents/Downloads in one PowerShell call, memoised per process as a `Promise`. Kick it off on the first `GET /locations`. Keep the env fallbacks | `workspace-routes.ts:223-301` | S | none | Second open of Desktop under 50 ms. First open is no slower than today |
| 1.4 | **Honest location states.** On `browser/open`, map ENOENT for an absent Projects folder to `location_missing` with "No Projects folder at ~/Projects; set `LIGHTCODE_PROJECTS_PATH`". The client greys that row for the rest of the session. No up-front probing (DESIGN.md:142) | `workspace-routes.ts:569-647`, `packages/ai/src/workspace-browser.ts` (state enum + `missing`), `project-browser.tsx` | S | none | No Retry loop for a never-existing Projects folder. The message names the path and the env override |
| 1.5 | **Windows-aware listing.** Directories first. `directoriesOnly` defaults to true, with a "Show files" toggle. Hide registry hive names (`NTUSER.DAT*`, `ntuser.ini`), `desktop.ini`, and profile legacy junctions (`symlinkState` internal + known names) unless "Show hidden" is on | `workspace-routes.ts:1048-1104,1486`, `packages/ai/src/workspace-browser.ts` (request flag), `api.ts:567-569`, `project-browser.tsx` | S | none | Home on Windows shows only real folders by default. Tests cover junction and hive names |
| 1.6 | **Path transparency.** Return an optional `hostPath` to authenticated web clients for all grant kinds, shown as a tooltip/`title` and in a "Project" disclosure. Use platform-correct shortcut glyphs | `workspace-routes.ts` (grant schema), `workspace-ribbon.tsx`, `session-rail.tsx:71,86` | S | none | Tooltip shows `C:\Users\…\OneDrive\Desktop\foo`. Windows shows `Ctrl`; macOS shows `⌘` |
| 1.7 | **Non-modal chooser.** Make `ProjectBrowser` a side sheet docked to the rail. No `inert` on main while the OS dialog is pending | `components/project-browser.tsx`, `app.tsx:474`, `styles.css` | M | 1.1, 1.2 (final section layout) | Chat stays usable while browsing. Esc closes and focus returns to the trigger. The dialog passes axe |

### Phase 2: TUI (`apps/cli`), parallel to Phase 3

| # | Item | Files | Effort | Deps | Acceptance |
| --- | --- | --- | --- | --- | --- |
| 2.1 | **Reclaim vertical space.** Single-row header with no paddingY. Drop body `padding={1}`. Replace "Conversation · N messages" with a one-line session header (title · project · branch) | `apps/cli/src/app.tsx`, `components/chat/chat-shell.tsx` | S | none | Transcript gains ≥5 rows on a 30-row terminal. Information moved, not removed |
| 2.2 | **F2 below 100 columns** opens a single-pane drawer (Explorer or Changes over chat) instead of doing nothing | `components/chat/ide-layout.tsx`, `screens/chat-screen.tsx:557-560` | S | none | F2 always does something visible at 80 cols |
| 2.3 | **Windows key audit.** Make Alt+Enter / Shift+Enter newline and F1 help primary where Ctrl+Enter or Ctrl+/ can't be distinguished | `components/chat/chat-text-area.tsx`, `utils/key-utils.ts`, `components/help-overlay.tsx` | S | none | Manual check in Windows Terminal, conhost and the VS Code terminal: newline and help work |
| 2.4 | **Split `chat-screen.tsx`** with no behaviour change, in isolated PRs. Targets: `screens/chat/use-chat-session.ts`, `screens/chat/use-ide-panels.ts`, `screens/chat/use-chat-keyboard.ts`, `screens/chat/chat-overlays.tsx`, `screens/chat/ide-workspace.tsx`. Split `file-explorer-panel.tsx` into `components/chat/explorer-tree.tsx`, `changes-tab.tsx`, `editor-pane.tsx`. Move `TabButton` to `ui/components/tab-button.tsx` | listed | L | none (do before 2.5-2.8) | No file over ~600 lines (screen file under 400). Existing tests pass. Kebab-case names; screens vs components respected |
| 2.5 | **Focus regions + keymap registry.** Add `apps/cli/src/state/focus-regions.ts` with a stack: chat / explorer / editor / overlay. Tab and Shift+Tab cycle regions, including back to chat. Ctrl+T cycles mode everywhere. Esc pops overlays only. Context bindings are registered in `commands/keymap.ts`, not inline | `state/focus-regions.ts`, `commands/keymap.ts`, `use-chat-keyboard.ts`, `app.tsx` | M | 2.4 | Precedence unit tests for every overlay. Tab always moves forward |
| 2.6 | **One hint slot + generated help.** The focused region owns a single hint line; the footer shows global state only. The F1 overlay is generated from the registry, filterable, with the current region first | `app.tsx`, `ide-layout.tsx`, `components/help-overlay.tsx` | M | 2.5 | Never more than one hint string. A test asserts help entries equal the registered bindings |
| 2.7 | **Adaptive IDE layouts:** `chat`, `chat+explorer`, `chat+editor`, `ide`. F2 cycles them. Resize the focused pane with Ctrl+←/→ (Alt+←/→ fallback, verified in 2.3); `z` zooms. Widths persist in settings under `tui.layout`, zod-validated | `ide-layout.tsx`, `state/app-state.tsx`, settings schema in `packages/ai/src/config` | M | 2.4, 2.5 | Each layout renders at 80/100/140 cols without clipping. Widths persist across runs |
| 2.8 | **Editor browse focus + polish:** PgUp/PgDn, g/G, `/` find in browse mode; scrollable tab strip; dirty-close prompt | `components/chat/editor-pane.tsx`, `file-editor.tsx`, `use-file-content.ts` | M | 2.4 | Scroll a 2,000-line file without edit mode. Closing a dirty tab asks first |
| 2.9 | **Message density.** Gutter marker plus whitespace for user and assistant text; cards only for tools, approvals, errors and plans; one-line tool summaries that expand with Ctrl+O | `components/chat/chat-message.tsx`, `chat-message-tool-invocation-part.tsx`, `ui/cli-theme.ts` | M | 4.3 (shared tool summaries) preferred | About 30% more content per screen in a 40-message session |
| 2.10 | **Home screen:** recent sessions, current project, quick actions; hide the ASCII art under 40 rows | `screens/home-screen.tsx`, `components/home-*.tsx` | S | none | Enter on a recent session resumes it |

### Phase 3: Web (`apps/web`), parallel to Phase 2

| # | Item | Files | Effort | Deps | Acceptance |
| --- | --- | --- | --- | --- | --- |
| 3.1 | **Tool renderers.** edit/write show a unified diff; bash shows command + exit code + collapsible output; read/grep/glob show path chips + counts. Raw JSON only behind "Details". Parse tool inputs with zod at the renderer boundary, falling back to raw | `components/chat-message.tsx`, new `components/tool-parts/*.tsx` (kebab-case) | M | 4.3 | Edit tool shows +/- lines. No raw JSON by default |
| 3.2 | **Run status strip:** ctx %, compaction count, cost, todo popover in the composer toolbar | `components/command-composer.tsx`, `chat-surface.tsx`, `lib/api.ts` | S | none | Values match the TUI for the same session |
| 3.3 | **Session rail grouping** by project, current project pinned, consistent labels | `components/session-rail.tsx` | S | 1.6 | TUI and web sessions for the same folder are in one group |
| 3.4 | **Changes panel.** Right side ≥1100 px, drawer below that. Changes (git status + per-file diff), then Files (lazy tree), then a read-only viewer. Toggle with Ctrl/Cmd+B and a header button; updates after each tool result | new `components/changes-panel.tsx`, `diff-view.tsx`, `file-viewer.tsx`, `app.tsx`, `styles.css` | L | 4.1, 4.2 | Lists changed files with +/- counts; click shows the diff; keyboard reachable; works at 760 px |
| 3.5 | **Shortcuts sheet** (`?`): Ctrl/Cmd+B panel, Ctrl/Cmd+. stop, Ctrl/Cmd+O open project | new `components/shortcuts-dialog.tsx`, `app.tsx` | S | 3.4 for Ctrl+B | All listed shortcuts work on Windows (Ctrl) and macOS (Cmd) |
| 3.6 | **Light theme.** Tokens under `@media (prefers-color-scheme: light)` plus a manual toggle; localStorage in try/catch | `styles.css`, `DESIGN.md`, `app.tsx` | M | 4.4 preferred | WCAG AA for text tokens in both themes |
| 3.7 | **CSS split** into per-component files with one breakpoint section each; remove the duplicate 760 px blocks | `apps/web/src/styles/*.css`, web build script | M | after 3.4 lands (conflict risk) | No visual diff at 1440/1100/760/390/320 |
| 3.8 | **Responsive polish:** virtualised folder and session lists; 44 px targets in the chooser | `project-browser.tsx`, `session-rail.tsx`, `styles.css` | S | 1.7 | A 1,000-entry folder scrolls smoothly; no overflow at 320 px |

### Phase 4: shared / server

| # | Item | Files | Effort | Deps | Acceptance |
| --- | --- | --- | --- | --- | --- |
| 4.1 | **Session files API:** `GET /sessions/:id/tree?segments=`, `GET /sessions/:id/file?segments=`. Bounded by the session cwd (reuse `resolve-within-workspace`); size caps, binary detection, secret-file rules shared with the read tool. Query/params validated with `zValidator` | new `apps/server/src/routes/session-files-routes.ts`, `apps/server/src/app.ts` | M | none | Traversal, symlink-escape, Windows backslash and case tests. A file over the cap is truncated with a flag |
| 4.2 | **Session changes API:** `GET /sessions/:id/changes`, `GET /sessions/:id/changes/:fileId/diff` (opaque fileId, not a path), reusing `packages/ai/src/git/runtime.ts` | same route file | M | 4.1 | Matches TUI Changes for the same repo |
| 4.3 | **Shared presentation model:** diff hunking, tool summaries (verb/target), mode/permission labels in `packages/shared` | `packages/shared/src/*`, CLI `chat-message-tool-invocation-part.tsx`, web `chat-message.tsx` | M | none | One source for labels; snapshot tests on both renderers |
| 4.4 | **Design tokens single source:** `packages/shared/src/design-tokens.ts` generates `cli-theme.ts` colours and the web `:root` tokens; snapshot-test `cliTheme` | `packages/shared`, `apps/cli/src/ui/cli-theme.ts`, `apps/web/src/styles.css` | S | none | Changing a token updates both surfaces; TUI visually unchanged |
| 4.5 | **Doctor check** "native folder picker": runs the §2.3 prologue on demand; shown in web and TUI `/doctor` | `apps/server/src/routes/diagnostics-routes.ts`, `native-directory-picker.ts` | S | 0.1 | Doctor reports engine/CLR and pass/fail with the diagnostic |
| 4.6 | **Windows CI lane** (no CI exists yet; no `.github/`): `bun test` on `windows-latest`, including the prologue test. Un-skip `workspace-routes.test.ts:798,856,975` with win32 expectations | new CI config, tests | M | 0.1 | Restoring line 149 fails CI |

---

## 5. Where the two research plans differed, and how it was resolved

| Topic | Opus | Fable | Resolution (evidence) |
| --- | --- | --- | --- |
| Engine for the dialog | Keep `powershell.exe`. Later move to `IFileOpenDialog` via `Add-Type` C#, keeping WinForms as a fallback | Prefer `pwsh.exe` (modern dialog), discovered from `%ProgramFiles%\PowerShell\7` **or the WindowsApps alias** | **Keep `powershell.exe` in Phase 0.** Verified: on this machine `pwsh` exists *only* as `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`, a user-writable directory. Allow-listing it would weaken the deliberate "no PATH / fixed system location" rule (`native-directory-picker.ts:306-320`), and two engines double the test matrix. `IFileOpenDialog` compiles C# at runtime, which Constrained Language Mode or EDR on corporate laptops can block. Both are **deferred** |
| Guard vs delete the property | Delete, or guard with `Get-Member` | Delete, or guard with `PSObject.Properties` | **Delete.** The pinned engine never has it, so a guard is dead code. The §2.3 tests catch reintroduction |
| Script line numbers | `:142-171` | `:128-158` | Opus is correct. Verified: the script spans 142-171, the property is at 149 |
| Dialog placement | Measured: visible, not foreground or topmost | Suspected off-screen / on no monitor | Opus's measurement wins: visible but behind. Fix with a taskbar button, an on-screen owner and web copy (0.1, 0.3). Forcing the foreground is best effort only |
| Exempt `browser/open` from the idle timeout | No | Yes | **No.** Its PowerShell call is hard-capped at 2 s (`workspace-routes.ts:283`) and gets cached in 1.3, so it can't approach 30 s |
| Projects-missing handling | Map ENOENT to a clear "not found" | Probe all locations at `GET /locations` with `fs.stat` | **Lazy (Opus).** `apps/web/DESIGN.md:142` says "Don't silently probe local folders". The client greys the row after the first `location_missing` |
| Help overlay | "Static dump, hand-written" | "Generated from the keymap" | **Both partly right.** Verified at `help-overlay.tsx:4-10`: global bindings are generated, context hints are hand-written strings. Fix in 2.6 |
| Path labels | Inconsistent between grant kinds | "pathLabel is never a host path" | **Opus is correct.** Native grants store `pathLabel: directory.root` (`workspace-routes.ts:1342-1346`); browser grants store `Location/seg` |
| Segment rules | Separators/dot rejected | Also claims `:` rejected | Verified: only `\0`, `/`, `\` and `.`/`..` are rejected (`workspace-browser.ts:63-72`). So the 1.2 drive tokens need explicit server-side validation |
| Launch folder | Proposed (`launch-cwd`) | Absent | **Adopted into Phase 0 (0.4).** It works even when the dialog is blocked by policy. Verified the spawn inherits cwd (`server-launcher.ts:286-296`) |
| "Open path..." text box | Not proposed | Proposed behind a product decision | **Deferred.** It conflicts with `PRODUCT.md:45` and `DESIGN.md:142`. Drives plus recents plus launch folder cover the need |
| Phase order | TUI phase before web | Project access, then web and TUI in parallel | **Fable's order**, because it finishes the Windows story first. TUI and web are independent streams after Phase 1 |
| TUI shortcuts | Ctrl+←/→ resize, `z` zoom | Ctrl+B explorer, Ctrl+J chat column, Ctrl+X leader | **Reject Ctrl+B** (the tmux prefix) **and Ctrl+J** (LF, often the same as Enter). Leader key deferred. Ctrl+B stays web-only |
| Smoke test gating | Opt-in env | Opt-in env | **Default-on for win32** with an opt-out. Opt-in tests never run, which is how the regression shipped (all Windows picker tests stub `runProcess`, `native-directory-picker.test.ts:17-101`) |
| Cold-start time | 12-15 s | 18-19 s | This pass measured `Add-Type` alone at 9.1 s. Plan for 5-20 s; the copy says "up to ~20 s" |

---

## 6. Risks, open questions, deferred items

**Risks**
- **Foreground lock.** Windows may still refuse to bring the dialog forward. The taskbar button plus
  the web copy are the reliable mitigation; verify manually with Chrome and Edge in front.
- **Prologue test runtime.** It takes about 10-20 s cold on win32. It's isolated in its own file
  with a 90 s timeout, and it may flake on heavily loaded CI. If so, keep it but move it to the
  Windows CI lane only.
- **Drives widen enumeration.** Mitigated by server-minted tokens, non-selectable roots, the
  broad-root confirmation, the capability TTL and web-auth. Network or removable drives are probed
  lazily, never auto-expanded.
- **Recent-project re-grant.** A folder replaced since last use must fail the identity check
  (dev/ino), not silently grant.
- **Refactors 2.4 and 3.7** carry merge-conflict risk. Land them as no-behaviour-change PRs between
  feature work.
- **Session files API (4.1)** exposes file content to the browser. Size caps, `.gitignore` and
  secret-file rules must match the agent's read tool.
- **Docs drift.** AGENTS.md says the server port defaults to 3000 and that no test script exists.
  The code has `PORT ?? 4983` (`apps/server/src/index.ts:95`) and `"test": "bun test"`
  (`package.json:16`). Worth a separate one-line docs fix.

**Open questions for the user**
1. Should drive roots be **browsable** (1.2), or should Windows rely only on the launch folder,
   recents and a working dialog?
2. When the web app starts with no stored project, should the launch folder be **auto-selected**,
   or offered as one click (the current plan)?
3. Is an **"Open path..."** box acceptable if it is gated by web-auth plus confirmation? This
   requires amending PRODUCT.md and DESIGN.md.
4. Is a later **`IFileOpenDialog`** picker worth the CLM/EDR risk, or should we ship a tiny prebuilt
   helper exe instead?
5. Which installed version does the Windows user run? Repo `dist/` is a stale 0.7.1 with no picker,
   so the fix must ship as a release; the published bundle should be checked for line 149.

**Explicitly deferred**
- `pwsh` engine preference and the `IFileOpenDialog` / COM `BrowseForFolder` picker.
- "Open path..." endpoint.
- TUI leader key (`ctrl+x`).
- Web activity/timeline rail.
- Pre-warming a PowerShell process on web load.
- TUI light palette / `LIGHTCODE_THEME` (after 4.4).
- Web file *editing* (read-only viewer first).
- Unverified items: ARM64 Windows, machines with only PowerShell 7, and the packaged-`dist` path.
