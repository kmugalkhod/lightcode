import { TextAttributes, type TextareaRenderable } from "@opentui/core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cliTheme } from "../../ui/cli-theme";
import { fuzzyFilter } from "../../utils/fuzzy-match";

interface TextareaKeyEvent {
  name: string;
  ctrl?: boolean;
  preventDefault: () => void;
}

interface ChatTextAreaProps {
  onSubmit: (text: string) => void;
  placeholder: string;
  focused?: boolean;
  disabled?: boolean;
  allowEmpty?: boolean;
  trimOnSubmit?: boolean;
  containerHeight?: number;
  beforeInput?: ReactNode;
  footer?: ReactNode;
  modeToggleHint?: boolean;
  slashMenuOpen?: boolean;
  onTextChange?: (text: string) => void;
  /** Workspace file paths for the @-mention picker; enables it when set. */
  mentionCandidates?: readonly string[];
}

const trailingMentionPattern = /(?:^|\s)@([^\s@]*)$/;

function getTrailingMentionQuery(text: string): string | null {
  const match = text.match(trailingMentionPattern);
  return match ? match[1] : null;
}

const textareaKeyBindings: Array<{
  name: string;
  ctrl?: boolean;
  action: "newline" | "submit";
}> = [
  { name: "return", ctrl: true, action: "newline" },
  { name: "enter", ctrl: true, action: "newline" },
  { name: "linefeed", ctrl: true, action: "newline" },
  { name: "return", action: "submit" },
  { name: "enter", action: "submit" },
];

export function ChatTextArea({
  onSubmit,
  placeholder,
  focused = true,
  disabled = false,
  allowEmpty = false,
  trimOnSubmit = true,
  containerHeight,
  beforeInput,
  footer,
  modeToggleHint = false,
  slashMenuOpen = false,
  onTextChange,
  mentionCandidates,
}: ChatTextAreaProps) {
  const textareaRef = useRef<TextareaRenderable>(null);
  const lastManualNewlineAt = useRef(0);
  const wasSlashMenuOpen = useRef(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionSelected, setMentionSelected] = useState(0);
  const isFocused = focused && !disabled;
  const inputHint = modeToggleHint
    ? "Enter to send | Ctrl+Enter for newline | Tab/Ctrl+T to switch mode"
    : "Enter to send | Ctrl+Enter for newline";

  const mentionMatches =
    mentionQuery !== null && mentionCandidates && mentionCandidates.length > 0
      ? fuzzyFilter(mentionQuery, mentionCandidates)
      : [];
  const selectedMentionIndex = Math.min(
    mentionSelected,
    Math.max(mentionMatches.length - 1, 0),
  );

  const acceptMention = useCallback(
    (mentionPath: string) => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }

      const normalizedPath = mentionPath.replaceAll("\\", "/");
      const currentText = textarea.plainText;
      const replaced = currentText.replace(
        trailingMentionPattern,
        (match) => `${match.startsWith("@") ? "" : match[0]}@${normalizedPath} `,
      );
      textarea.setText(replaced);
      setMentionQuery(null);
      setMentionSelected(0);
      onTextChange?.(replaced);
    },
    [onTextChange],
  );

  const handleKeyDown = useCallback(
    (event: TextareaKeyEvent) => {
      const isEnterLike =
        event.name === "return" ||
        event.name === "enter" ||
        event.name === "linefeed";

      if (isEnterLike && event.ctrl) {
        event.preventDefault();
        lastManualNewlineAt.current = Date.now();
        textareaRef.current?.newLine();
        return;
      }

      if (mentionMatches.length === 0) {
        return;
      }

      if (event.name === "tab") {
        event.preventDefault();
        acceptMention(mentionMatches[selectedMentionIndex]);
      } else if (event.name === "down") {
        event.preventDefault();
        setMentionSelected((index) =>
          Math.min(index + 1, mentionMatches.length - 1),
        );
      } else if (event.name === "up") {
        event.preventDefault();
        setMentionSelected((index) => Math.max(index - 1, 0));
      } else if (event.name === "escape") {
        event.preventDefault();
        setMentionQuery(null);
        setMentionSelected(0);
      }
    },
    [acceptMention, mentionMatches, selectedMentionIndex],
  );

  const handleSubmit = useCallback(() => {
    if (Date.now() - lastManualNewlineAt.current < 100 || disabled) {
      return;
    }

    const rawText = textareaRef.current?.plainText ?? "";
    const submittedText = trimOnSubmit ? rawText.trim() : rawText;

    if (!allowEmpty && submittedText.length === 0) {
      return;
    }

    onSubmit(submittedText);
    textareaRef.current?.setText("");
    setMentionQuery(null);
    setMentionSelected(0);
    onTextChange?.("");
  }, [allowEmpty, disabled, onSubmit, onTextChange, trimOnSubmit]);

  const handleContentChange = useCallback(() => {
    const currentText = textareaRef.current?.plainText ?? "";
    if (mentionCandidates) {
      setMentionQuery(getTrailingMentionQuery(currentText));
      setMentionSelected(0);
    }
    onTextChange?.(currentText);
  }, [mentionCandidates, onTextChange]);

  // Slash menu close behavior: clear input only if text is still a pure slash command.
  // Do NOT clear if user added text after the slash (e.g., "/status something").
  useEffect(() => {
    if (wasSlashMenuOpen.current && !slashMenuOpen) {
      const currentText = textareaRef.current?.plainText ?? "";
      const trimmed = currentText.trimStart();

      if (trimmed.startsWith("/")) {
        // Only clear if it's a pure slash command with no trailing text
        // Pattern: /command where command is alphanumeric/dash only, or just "/"
        const isPureSlashCommand =
          trimmed === "/" ||
          /^\/[a-zA-Z0-9-]+$/.test(trimmed);

        if (isPureSlashCommand) {
          textareaRef.current?.setText("");
          onTextChange?.("");
        }
      }
    }

    wasSlashMenuOpen.current = slashMenuOpen;
  }, [onTextChange, slashMenuOpen]);

  return (
    <box width="100%" flexDirection="column" gap={1}>
      {beforeInput}
      {mentionMatches.length > 0 ? (
        <box
          flexDirection="column"
          borderStyle="single"
          borderColor={cliTheme.overlay.border}
          backgroundColor={cliTheme.overlay.surface}
          paddingX={1}
        >
          {mentionMatches.map((mentionPath, index) => (
            <text
              key={mentionPath}
              fg={
                index === selectedMentionIndex
                  ? cliTheme.overlay.selectedRowText
                  : cliTheme.text.secondary
              }
              bg={
                index === selectedMentionIndex
                  ? cliTheme.overlay.selectedRowBackground
                  : undefined
              }
              attributes={
                index === selectedMentionIndex
                  ? TextAttributes.BOLD
                  : TextAttributes.NONE
              }
            >
              {`${index === selectedMentionIndex ? "> " : "  "}${mentionPath}`}
            </text>
          ))}
          <text fg={cliTheme.overlay.footerText} attributes={TextAttributes.DIM}>
            Tab attach | Up/Down select | Esc dismiss
          </text>
        </box>
      ) : null}
      <box
        flexDirection="column"
        borderStyle="single"
        borderColor={isFocused ? cliTheme.input.focusedBorder : cliTheme.input.blurredBorder}
        backgroundColor={cliTheme.input.container}
        paddingX={1}
        paddingY={1}
        height={containerHeight}
        gap={1}
      >
        <textarea
          ref={textareaRef}
          initialValue=""
          onKeyDown={handleKeyDown}
          onSubmit={handleSubmit}
          onContentChange={handleContentChange}
          keyBindings={textareaKeyBindings}
          placeholder={placeholder}
          width="100%"
          height={3}
          wrapMode="word"
          backgroundColor={cliTheme.input.field}
          focusedBackgroundColor={cliTheme.input.field}
          textColor={cliTheme.input.text}
          cursorColor={cliTheme.input.cursor}
          placeholderColor={cliTheme.input.placeholder}
          focused={isFocused}
        />
        <text fg={cliTheme.input.hint}>{inputHint}</text>
        {footer}
      </box>
    </box>
  );
}
