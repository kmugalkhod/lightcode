import type { ReactNode } from "react";
import type { PermissionMode } from "@lightcode/ai";
import { borderStyleFor, cliTheme, typeRole } from "../../ui/cli-theme";
import { terminalCapabilities } from "../../ui/cli-theme-capabilities";
import { Badge } from "../../ui/components/badge";
import { TabButton } from "./file-explorer-panel";

const UNICODE = terminalCapabilities.unicode;
const BRANCH_GLYPH = UNICODE ? "⎇" : "git";
const AHEAD_GLYPH = UNICODE ? "↑" : "+";
const BEHIND_GLYPH = UNICODE ? "↓" : "-";

interface IdeLayoutProps {
  /** Left sidebar (Explorer tree / Changes). */
  explorer: ReactNode;
  /** Center editor pane (tabs + breadcrumb + buffer). */
  editor: ReactNode;
  /** Right chat column (ChatShell + input). */
  chat: ReactNode;
  /** Turn the IDE layout off (back to full-screen chat). */
  onExitIde: () => void;

  // Status-bar context (read-only; the chat screen owns all of this state).
  /** Current git branch, or null when detached / not a repo. */
  branch: string | null;
  ahead: number;
  behind: number;
  /** Path of the file shown in the editor, centered in the status bar. */
  activeFilePath: string | null;
  /** Agent mode label (e.g. "Build"). */
  modeLabel: string;
  /** Permission mode, drives the right-side badge tone. */
  permissionMode: PermissionMode | undefined;
  /** Line count of the active file (0 when none / loading). */
  lineCount: number;
}

/** Tone for the permission badge — mirrors the chat footer's mapping. */
function permissionTone(mode: PermissionMode | undefined) {
  if (mode === "danger-full-access") return "error" as const;
  if (mode === "read-only") return "neutral" as const;
  return "accent" as const;
}

/**
 * Full-width bottom status bar, VS Code style: git branch (with ahead/behind)
 * on the left, the active file path centered, and agent/permission/line-count
 * metadata on the right. Chrome only — every value is passed in.
 */
function StatusBar({
  branch,
  ahead,
  behind,
  activeFilePath,
  modeLabel,
  permissionMode,
  lineCount,
}: Omit<IdeLayoutProps, "explorer" | "editor" | "chat" | "onExitIde">) {
  return (
    <box
      flexDirection="row"
      alignItems="center"
      flexShrink={0}
      paddingX={1}
      borderStyle={borderStyleFor.chrome}
      border={["top"]}
      borderColor={cliTheme.borders.subtle}
      backgroundColor={cliTheme.surfaces.panel}
    >
      <box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
        <text fg={cliTheme.accent.primary}>{BRANCH_GLYPH}</text>
        <text {...typeRole("caption")}>{branch ?? "(detached)"}</text>
        {ahead > 0 ? <text {...typeRole("caption")}>{`${AHEAD_GLYPH}${ahead}`}</text> : null}
        {behind > 0 ? <text {...typeRole("caption")}>{`${BEHIND_GLYPH}${behind}`}</text> : null}
      </box>
      <box flexGrow={1} flexDirection="row" justifyContent="center" alignItems="center">
        {activeFilePath ? <text {...typeRole("caption")}>{activeFilePath}</text> : null}
      </box>
      <box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
        <text>
          <span fg={cliTheme.accent.primary}>{modeLabel}</span>
          <span fg={cliTheme.text.muted}> mode</span>
        </text>
        <Badge tone={permissionTone(permissionMode)} label={permissionMode ?? "default"} />
        <text {...typeRole("caption")}>
          {lineCount > 0 ? `${lineCount} ln · UTF-8` : "UTF-8"}
        </text>
      </box>
    </box>
  );
}

/**
 * Three-pane IDE shell: Explorer (left) · Editor (center, the focal point) ·
 * Chat (right) — the terminal rendering of the GLM/Z.ai IDE layout. Pure layout;
 * the chat screen composes each pane and owns all state.
 */
export function IdeLayout({
  explorer,
  editor,
  chat,
  onExitIde,
  branch,
  ahead,
  behind,
  activeFilePath,
  modeLabel,
  permissionMode,
  lineCount,
}: IdeLayoutProps) {
  return (
    <box width="100%" height="100%" flexDirection="column">
      <box
        flexDirection="row"
        alignItems="center"
        flexShrink={0}
        gap={1}
        paddingX={1}
        borderStyle={borderStyleFor.chrome}
        border={["bottom"]}
        borderColor={cliTheme.borders.default}
        backgroundColor={cliTheme.surfaces.panel}
      >
        <TabButton label="Terminal" active={false} onPress={onExitIde} />
        <TabButton label="IDE" active onPress={() => {}} />
        <box flexGrow={1} />
        <text {...typeRole("caption")}>F2 exit IDE</text>
      </box>

      <box flexDirection="row" flexGrow={1} width="100%" gap={2} paddingX={1} paddingTop={1}>
        <box width="22%" minWidth={22} height="100%" flexDirection="column">
          {explorer}
        </box>
        <box flexGrow={1} height="100%" flexDirection="column">
          {editor}
        </box>
        <box width="34%" minWidth={40} height="100%" flexDirection="column">
          {chat}
        </box>
      </box>

      <StatusBar
        branch={branch}
        ahead={ahead}
        behind={behind}
        activeFilePath={activeFilePath}
        modeLabel={modeLabel}
        permissionMode={permissionMode}
        lineCount={lineCount}
      />
    </box>
  );
}
