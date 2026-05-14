import type { TextareaRenderable } from "@opentui/core";
import type { ReactNode } from "react";
import { useRef } from "react";

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
}

const textareaKeyBindings: Array<{
  name: string;
  ctrl?: boolean;
  action: "newline" | "submit";
}> = [
  { name: "return", ctrl: true, action: "newline" },
  { name: "enter", ctrl: true, action: "newline" },
  { name: "linefeed", ctrl: true, action: "newline" },
  { name: "linefeed", action: "newline" },
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
}: ChatTextAreaProps) {
  const textareaRef = useRef<TextareaRenderable>(null);
  const lastManualNewlineAt = useRef(0);
  const isFocused = focused && !disabled;

  return (
    <box width="100%" flexDirection="column" gap={1}>
      {beforeInput}
      <box
        flexDirection="column"
        borderStyle="single"
        borderColor="#2D2D2D"
        paddingX={2}
        paddingY={1}
        height={containerHeight}
      >
        <textarea
          ref={textareaRef}
          initialValue=""
          onKeyDown={(event: TextareaKeyEvent) => {
            const isEnterLike =
              event.name === "return" ||
              event.name === "enter" ||
              event.name === "linefeed";

            if (isEnterLike && (event.ctrl || event.name === "linefeed")) {
              event.preventDefault();
              lastManualNewlineAt.current = Date.now();
              textareaRef.current?.newLine();
            }
          }}
          onSubmit={() => {
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
          }}
          keyBindings={textareaKeyBindings}
          placeholder={placeholder}
          width="100%"
          height={2}
          wrapMode="word"
          backgroundColor="#171717"
          focusedBackgroundColor="#171717"
          textColor="#F5F5F5"
          cursorColor="#F5F5F5"
          placeholderColor="#8A8A8A"
          focused={isFocused}
        />
        {footer ? <box paddingTop={1}>{footer}</box> : null}
      </box>
    </box>
  );
}
