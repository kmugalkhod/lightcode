import { TextAttributes } from "@opentui/core";
import { typeRole } from "../../ui/cli-theme";
import { useKeyboard } from "@opentui/react";
import type {
  PendingToolApproval,
  ToolApprovalAction,
} from "@lightcode/ai/react";
import { useEffect, useState } from "react";
import { isDownKey, isEnterKey, isEscapeKey, isUpKey } from "../../utils/key-utils";
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
}: ChatToolApprovalCardProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [keyboardActive, setKeyboardActive] = useState(false);
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
    if (approvals.length === 0) {
      return;
    }

    const keyName = keyEvent.name.toLowerCase();

    if (isDownKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      if (!keyboardActive) {
        setKeyboardActive(true);
        setSelectedIndex(0);
        return;
      }

      setKeyboardActive(true);
      setSelectedIndex((currentIndex) =>
        Math.min(currentIndex + 1, approvals.length - 1),
      );
      return;
    }

    if (isUpKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      if (!keyboardActive) {
        setKeyboardActive(true);
        setSelectedIndex(0);
        return;
      }

      setKeyboardActive(true);
      setSelectedIndex((currentIndex) => Math.max(currentIndex - 1, 0));
      return;
    }

    if (!keyboardActive) {
      return;
    }

    if (isEnterKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      onResolve("approve", safeSelectedIndex);
      return;
    }

    if (keyName === "d") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      onResolve("deny", safeSelectedIndex);
      return;
    }

    if (keyName === "a") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      onResolveAll("approve");
      return;
    }

    if (isEscapeKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setKeyboardActive(false);
    }
  });

  if (approvals.length === 0) {
    return null;
  }

  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={keyboardActive ? cliTheme.accent.primary : cliTheme.semantic.warning}
      backgroundColor={cliTheme.surfaces.panel}
      paddingX={1}
      paddingY={1}
      gap={1}
    >
      <box width="100%" flexDirection="row" justifyContent="space-between">
        <text fg={cliTheme.semantic.warning} attributes={typeRole("title").attributes}>
          Tool Approval
        </text>
        <text fg={keyboardActive ? cliTheme.accent.primary : cliTheme.text.muted}>
          {keyboardActive
            ? `keyboard focus - ${approvals.length} pending`
            : `${approvals.length} pending - press Down to focus`}
        </text>
      </box>

      <box width="100%" flexDirection="column">
        {approvals.map((approval, index) => {
          const rowColors = getOverlayRowColors(
            keyboardActive && index === safeSelectedIndex,
          );
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
                attributes={
                  keyboardActive && index === safeSelectedIndex
                    ? TextAttributes.BOLD
                    : TextAttributes.NONE
                }
              >
                {keyboardActive && index === safeSelectedIndex ? "> " : "  "}
                {index + 1}. {approval.toolName} {target}
              </text>
              <text
                fg={rowColors.secondaryTextColor}
                attributes={TextAttributes.DIM}
              >
                {getApprovalDescription(approval)}
              </text>
            </box>
          );
        })}
      </box>

      <box width="100%" flexDirection="row" justifyContent="space-between">
        <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
          {keyboardActive
            ? "Enter approve | d deny | a approve all | Esc release focus"
            : "Down focus card | or type approve/deny below"}
        </text>
        <text fg={cliTheme.text.secondary}>
          approve/deny also works in reply
        </text>
      </box>
    </box>
  );
}
