import { TextAttributes } from "@opentui/core";
import { typeRole } from "../../ui/cli-theme";
import { useKeyboard } from "@opentui/react";
import type {
  PendingToolApproval,
  ToolApprovalAction,
} from "@lightcode/ai/react";
import { useEffect, useState } from "react";
import { activeGlyphs } from "../../ui/cli-theme-capabilities";
import { isDownKey, isEnterKey, isUpKey } from "../../utils/key-utils";
import {
  getNumberProperty,
  getStringProperty,
  truncateInline,
} from "../../utils/text-utils";
import { cliTheme, getOverlayRowColors } from "../../ui/cli-theme";

interface ChatToolApprovalCardProps {
  approvals: PendingToolApproval[];
  onResolve: (action: ToolApprovalAction, index: number) => void;
  onResolveAll: (action: ToolApprovalAction) => void;
  /**
   * True while the chat reply box holds text. The card then yields the
   * keyboard so Enter submits the typed reply (e.g. an approve/deny command)
   * instead of silently approving a tool call.
   */
  hasDraftText?: boolean;
}

function getApprovalTarget(approval: PendingToolApproval): string {
  return (
    getStringProperty(approval.input, "path") ??
    getStringProperty(approval.input, "command") ??
    getStringProperty(approval.input, "query") ??
    getStringProperty(approval.input, "pattern") ??
    getStringProperty(approval.input, "revision") ??
    getStringProperty(approval.input, "url") ??
    approval.summary
  );
}

function getApprovalDescription(approval: PendingToolApproval): string {
  if (approval.toolName === "bash") {
    const timeoutMs = getNumberProperty(approval.input, "timeoutMs") ?? 30000;
    const reason = approval.permissionDecision.reason ?? "Approval is required.";
    return (
      `Classification: ${approval.permissionDecision.requiredMode}; ` +
      `cwd: ${approval.cwd}; timeout: ${timeoutMs}ms. ${reason}`
    );
  }

  if (approval.permissionDecision.reason) {
    return approval.permissionDecision.reason;
  }

  if (approval.toolName === "edit_file") {
    const replaceAll = Reflect.get(approval.input, "replaceAll") === true;
    return replaceAll ? "Replace all matching text." : "Replace the first matching text.";
  }

  if (approval.toolName === "write_file") {
    const content = getStringProperty(approval.input, "content") ?? "";
    return `Write file content (${content.length} characters).`;
  }

  return "Review before running this tool.";
}

export function ChatToolApprovalCard({
  approvals,
  onResolve,
  onResolveAll,
  hasDraftText = false,
}: ChatToolApprovalCardProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const safeSelectedIndex = Math.min(
    selectedIndex,
    Math.max(approvals.length - 1, 0),
  );

  useEffect(() => {
    setSelectedIndex((currentIndex) =>
      Math.min(currentIndex, Math.max(approvals.length - 1, 0)),
    );
  }, [approvals.length]);

  useKeyboard((keyEvent) => {
    // Only keys that are no-ops in an empty reply box are claimed here
    // (Enter, ↑/↓). Letters and digits always flow to the reply box, so
    // typing "add tests" or "deny 2" can never trigger an approval action.
    // Once the draft has text, everything (including Enter) belongs to it.
    if (approvals.length === 0 || hasDraftText) {
      return;
    }

    const keyName = keyEvent.name.toLowerCase();

    if (isDownKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setSelectedIndex((currentIndex) =>
        Math.min(currentIndex + 1, approvals.length - 1),
      );
      return;
    }

    if (isUpKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setSelectedIndex((currentIndex) => Math.max(currentIndex - 1, 0));
      return;
    }

    if (isEnterKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      onResolve("approve", safeSelectedIndex);
    }
  });

  if (approvals.length === 0) {
    return null;
  }

  const hint = hasDraftText
    ? "Finish your reply below — approve/deny commands work there"
    : [
        approvals.length > 1 ? "↑/↓ select" : null,
        "Enter approve",
        "type deny to reject",
        approvals.length > 1 ? "approve all / deny all" : null,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={cliTheme.semantic.warning}
      backgroundColor={cliTheme.surfaces.panel}
      paddingX={2}
      paddingY={1}
      gap={1}
    >
      <box width="100%" flexDirection="row" justifyContent="space-between">
        <text fg={cliTheme.semantic.warning} attributes={typeRole("title").attributes}>
          {activeGlyphs.toolApproval} Tool access request
        </text>
        <text fg={cliTheme.text.muted}>
          {approvals.length === 1 ? "1 pending" : `${approvals.length} pending`}
        </text>
      </box>

      <box width="100%" flexDirection="column">
        {approvals.map((approval, index) => {
          const selected = index === safeSelectedIndex;
          const rowColors = getOverlayRowColors(selected);
          const target = truncateInline(getApprovalTarget(approval));

          return (
            <box
              key={approval.toolCallId}
              width="100%"
              flexDirection="column"
              paddingX={1}
              backgroundColor={rowColors.backgroundColor}
            >
              <text
                fg={rowColors.primaryTextColor}
                attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
              >
                <span fg={selected ? cliTheme.accent.primary : cliTheme.text.muted}>
                  {selected ? `${activeGlyphs.roleUser} ` : "  "}
                  {index + 1}.{" "}
                </span>
                <span>{approval.toolName}</span>
                <span fg={rowColors.secondaryTextColor}> {target}</span>
              </text>
              <text
                fg={rowColors.secondaryTextColor}
                attributes={TextAttributes.DIM}
              >
                {"     "}
                {getApprovalDescription(approval)}
              </text>
            </box>
          );
        })}
      </box>

      <text {...typeRole("caption")}>{hint}</text>
    </box>
  );
}
