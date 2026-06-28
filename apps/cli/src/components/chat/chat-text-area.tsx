import {
  decodePasteBytes,
  type PasteEvent,
  stripAnsiSequences,
  TextAttributes,
  type TextareaRenderable,
} from "@opentui/core";
import { typeRole } from "../../ui/cli-theme";
import type { FileUIPart } from "ai";
import { appendFileSync } from "node:fs";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cliTheme, borderStyleFor } from "../../ui/cli-theme";
import { readClipboardImage } from "../../utils/clipboard-image";
import { fuzzyFilter } from "../../utils/fuzzy-match";
import {
  clipboardImageToFilePart,
  formatImageChip,
  stripImageChips,
} from "../../utils/image-attachments";
import {
  expandPastePlaceholders,
  formatPastePlaceholder,
  shouldCollapsePaste,
} from "../../utils/paste-placeholders";

// Temporary paste/image diagnostic: set LIGHTCODE_PASTE_DEBUG=1 to log events to
// /tmp/lightcode-paste-debug.log. Remove once image paste is confirmed.
function pasteDebug(message: string): void {
  if (!process.env.LIGHTCODE_PASTE_DEBUG) {
    return;
  }
  try {
    appendFileSync("/tmp/lightcode-paste-debug.log", `${message}\n`);
  } catch {
    // Diagnostics must never break the input.
  }
}

interface TextareaKeyEvent {
  name: string;
  ctrl?: boolean;
  preventDefault: () => void;
}

interface ChatTextAreaProps {
  onSubmit: (text: string, files?: FileUIPart[]) => void;
  placeholder: string;
  focused?: boolean;
  disabled?: boolean;
  allowEmpty?: boolean;
  trimOnSubmit?: boolean;
  containerHeight?: number;
  beforeInput?: ReactNode;
  footer?: ReactNode;
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
  slashMenuOpen = false,
  onTextChange,
  mentionCandidates,
}: ChatTextAreaProps) {
  const textareaRef = useRef<TextareaRenderable>(null);
  const lastManualNewlineAt = useRef(0);
  const wasSlashMenuOpen = useRef(false);
  // Full text of each collapsed paste, keyed by its placeholder number. Spliced
  // back in at submit time; reset after each send.
  const pasteStore = useRef<Map<number, string>>(new Map());
  const pasteCounter = useRef(0);
  // Pasted images, keyed by their chip number. Sent as file parts at submit;
  // reset after each send.
  const imageStore = useRef<Map<number, FileUIPart>>(new Map());
  const imageCounter = useRef(0);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionSelected, setMentionSelected] = useState(0);
  const isFocused = focused && !disabled;

  // Collapse large pastes into a short placeholder so the box stays readable.
  // Runs as the textarea's paste handler: for a big paste we preventDefault to
  // suppress the raw insert, drop in a short placeholder, and stash the full
  // body in `pasteStore` to splice back at submit time. Small pastes fall
  // through to the default handler and insert normally.
  // Pull an image off the OS clipboard and attach it as a chip. Used by both the
  // empty-paste path and the Ctrl+V fallback (for terminals that send no paste
  // event for image clipboard data). No-op when the clipboard holds no image.
  const attachClipboardImage = useCallback(() => {
    void readClipboardImage().then((image) => {
      pasteDebug(
        `clipboard read: ${image ? `image ${image.byteLength} bytes` : "no image"}`,
      );
      const textarea = textareaRef.current;
      if (!image || !textarea) {
        return;
      }
      const index = imageCounter.current + 1;
      imageCounter.current = index;
      imageStore.current.set(index, clipboardImageToFilePart(index, image));
      textarea.insertText(formatImageChip(index));
      onTextChange?.(textarea.plainText);
    });
  }, [onTextChange]);

  const handlePaste = useCallback(
    (event: PasteEvent) => {
      const pasted = stripAnsiSequences(decodePasteBytes(event.bytes));
      pasteDebug(
        `paste fired: bytes=${event.bytes?.length ?? "?"} decodedLen=${pasted.length} empty=${pasted.trim().length === 0}`,
      );
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }

      // A pasted screenshot arrives as an empty paste (terminals forward no
      // bytes for image clipboard data); recover it from the OS clipboard and
      // drop in a chip. The full image rides along as a file part on submit.
      if (pasted.trim().length === 0) {
        event.preventDefault();
        attachClipboardImage();
        return;
      }

      if (!shouldCollapsePaste(pasted)) {
        return;
      }

      event.preventDefault();
      const index = pasteCounter.current + 1;
      pasteCounter.current = index;
      pasteStore.current.set(index, pasted);
      textarea.insertText(formatPastePlaceholder(index, pasted));

      const next = textarea.plainText;
      if (mentionCandidates) {
        setMentionQuery(getTrailingMentionQuery(next));
        setMentionSelected(0);
      }
      onTextChange?.(next);
    },
    [mentionCandidates, onTextChange],
  );

  // Attach the paste handler straight to the renderable so it intercepts the
  // focused textarea's paste before the default raw insert.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.onPaste = handlePaste;
    return () => {
      if (textarea.onPaste === handlePaste) {
        textarea.onPaste = undefined;
      }
    };
  }, [handlePaste]);

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

      // Ctrl+V grabs an image off the clipboard directly — a fallback for
      // terminals that don't emit a paste event for image clipboard data.
      if (event.name === "v" && event.ctrl) {
        event.preventDefault();
        pasteDebug("ctrl+v: grab clipboard image");
        attachClipboardImage();
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
    [acceptMention, attachClipboardImage, mentionMatches, selectedMentionIndex],
  );

  const handleSubmit = useCallback(() => {
    if (Date.now() - lastManualNewlineAt.current < 100 || disabled) {
      return;
    }

    const rawText = textareaRef.current?.plainText ?? "";
    const expandedText = stripImageChips(
      expandPastePlaceholders(rawText, pasteStore.current),
    );
    const submittedText = trimOnSubmit ? expandedText.trim() : expandedText;
    const files = [...imageStore.current.values()];

    if (!allowEmpty && submittedText.length === 0 && files.length === 0) {
      return;
    }

    onSubmit(submittedText, files.length > 0 ? files : undefined);
    textareaRef.current?.setText("");
    pasteStore.current.clear();
    pasteCounter.current = 0;
    imageStore.current.clear();
    imageCounter.current = 0;
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
          borderStyle={borderStyleFor.card}
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
          <text {...typeRole("caption")}>
            Tab attach | Up/Down select | Esc dismiss
          </text>
        </box>
      ) : null}
      <box
        flexDirection="column"
        borderStyle={borderStyleFor.card}
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
        {footer}
      </box>
    </box>
  );
}
