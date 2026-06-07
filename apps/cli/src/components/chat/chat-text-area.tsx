import type { TextareaRenderable } from "@opentui/core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import { cliTheme } from "../../ui/cli-theme";

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
}: ChatTextAreaProps) {
  const textareaRef = useRef<TextareaRenderable>(null);
  const lastManualNewlineAt = useRef(0);
  const wasSlashMenuOpen = useRef(false);
  const isFocused = focused && !disabled;
  const inputHint = modeToggleHint
    ? "Enter to send | Ctrl+Enter for newline | Tab/Ctrl+T to switch mode"
    : "Enter to send | Ctrl+Enter for newline";

  const handleKeyDown = useCallback((event: TextareaKeyEvent) => {
    const isEnterLike =
      event.name === "return" ||
      event.name === "enter" ||
      event.name === "linefeed";

    if (isEnterLike && event.ctrl) {
      event.preventDefault();
      lastManualNewlineAt.current = Date.now();
      textareaRef.current?.newLine();
    }
  }, []);

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
    onTextChange?.("");
  }, [allowEmpty, disabled, onSubmit, onTextChange, trimOnSubmit]);

  const handleContentChange = useCallback(() => {
    onTextChange?.(textareaRef.current?.plainText ?? "");
  }, [onTextChange]);

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
