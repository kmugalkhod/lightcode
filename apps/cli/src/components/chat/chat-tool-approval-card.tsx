import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type {
  PendingToolApproval,
  ToolApprovalAction,
} from "@lightcode/ai/react";
import { useEffect, useState } from "react";
import { cliTheme, getOverlayRowColors } from "../../ui/cli-theme";

interface ChatToolApprovalCardProps {
  approvals: PendingToolApproval[];
  onResolve: (action: ToolApprovalAction, index: number) => void;
  onResolveAll: (action: ToolApprovalAction) => void;
}

function isDownKey(keyName: string) {
  return keyName === "down" || keyName === "arrowdown";
}

function isUpKey(keyName: string) {
  return keyName === "up" || keyName === "arrowup";
}

function isEnterKey(keyName: string) {
  return keyName === "enter" || keyName === "return";
}

function isEscapeKey(keyName: string) {
  return keyName === "escape";
}

function getStringInputProperty(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const value = Reflect.get(input, key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function getApprovalTarget(approval: PendingToolApproval): string {
  return (
    getStringInputProperty(approval.input, "path") ??
    getStringInputProperty(approval.input, "command") ??
    getStringInputProperty(approval.input, "query") ??
    approval.summary
  );
}

function getApprovalDescription(approval: PendingToolApproval): string {
  if (approval.toolName === "edit_file") {
    const replaceAll = Reflect.get(approval.input, "replaceAll") === true;
    return replaceAll ? "Replace all matching text." : "Replace the first matching text.";
  }

  if (approval.toolName === "write_file") {
    const content = getStringInputProperty(approval.input, "content") ?? "";
    return `Write file content (${content.length} characters).`;
  }

  if (approval.toolName === "bash") {
    return "Run this shell command from the workspace.";
  }

  return "Review before running this tool.";
}

function truncateInline(text: string, maxLength = 96): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
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
      borderColor={cliTheme.semantic.warning}
      backgroundColor={cliTheme.surfaces.panel}
      paddingX={1}
      paddingY={1}
      gap={1}
    >
      <box width="100%" flexDirection="row" justifyContent="space-between">
        <text fg={cliTheme.semantic.warning} attributes={TextAttributes.BOLD}>
          Tool Approval
        </text>
        <text fg={cliTheme.text.muted}>
          {approvals.length} pending
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
              <text fg={rowColors.primaryTextColor}>
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
          Up/Down focus | Enter approve | d deny | a approve all | Esc release
        </text>
        <text fg={cliTheme.text.secondary}>
          approve/deny also works in reply
        </text>
      </box>
    </box>
  );
}
