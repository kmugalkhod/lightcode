import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useMemo, useState } from "react";
import { cliTheme, getOverlayRowColors } from "../../ui/cli-theme";
import { isDownKey, isEnterKey, isEscapeKey, isUpKey } from "../../utils/key-utils";

interface InteractionOption {
  value: string;
  label: string;
  description?: string;
}

export interface ChatInteractionSubmitPayload {
  answer: string;
  selectedOption?: string;
  selectedValue?: string;
  source: "option" | "custom";
}

interface ChatInteractionPopupProps {
  title: string;
  question: string;
  options: InteractionOption[];
  allowCustomResponse?: boolean;
  placeholder?: string;
  submitLabel?: string;
  requireCustomResponseForValues?: string[];
  onSubmit: (payload: ChatInteractionSubmitPayload) => void;
  onCancel?: () => void;
}

const customOptionValue = "__custom_answer__";

export function ChatInteractionPopup({
  title,
  question,
  options,
  allowCustomResponse = false,
  placeholder = "Type your answer...",
  submitLabel = "Submit",
  requireCustomResponseForValues = [],
  onSubmit,
  onCancel,
}: ChatInteractionPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [customAnswer, setCustomAnswer] = useState("");
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const submitVerb = submitLabel.toLowerCase();
  const hintLabel = onCancel
    ? `Up/Down select | Enter ${submitVerb} | Esc dismiss`
    : `Up/Down select | Enter ${submitVerb}`;

  const rows = useMemo(() => {
    const optionRows = options.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
      isCustom: false,
    }));

    if (!allowCustomResponse) {
      return optionRows;
    }

    return [
      ...optionRows,
      {
        value: customOptionValue,
        label: "Type your own answer",
        description: undefined,
        isCustom: true,
      },
    ];
  }, [allowCustomResponse, options]);

  const safeSelectedIndex = Math.min(selectedIndex, Math.max(rows.length - 1, 0));
  const selectedRow = rows[safeSelectedIndex];

  const requiresCustomResponse = Boolean(
    selectedRow?.isCustom ||
      (selectedRow && requireCustomResponseForValues.includes(selectedRow.value)),
  );

  const canShowInput =
    requiresCustomResponse || (rows.length === 0 && allowCustomResponse);

  const submitCurrentSelection = () => {
    if (!selectedRow && !canShowInput) {
      return;
    }

    if (canShowInput) {
      const answer = customAnswer.trim();
      if (answer.length === 0) {
        setValidationMessage("Please enter a response before submitting.");
        return;
      }

      setValidationMessage(null);
      onSubmit({
        answer,
        selectedOption:
          selectedRow && !selectedRow.isCustom ? selectedRow.label : undefined,
        selectedValue:
          selectedRow && !selectedRow.isCustom ? selectedRow.value : undefined,
        source:
          selectedRow?.isCustom || !selectedRow || requiresCustomResponse
            ? "custom"
            : "option",
      });
      return;
    }

    setValidationMessage(null);
    onSubmit({
      answer: selectedRow.label,
      selectedOption: selectedRow.label,
      selectedValue: selectedRow.value,
      source: "option",
    });
  };

  useKeyboard((keyEvent) => {
    if (rows.length === 0 && !canShowInput) {
      if (isEscapeKey(keyEvent.name.toLowerCase()) && onCancel) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        onCancel();
      }
      return;
    }

    const keyName = keyEvent.name.toLowerCase();

    if (isDownKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setValidationMessage(null);
      setSelectedIndex((currentIndex) =>
        Math.min(currentIndex + 1, Math.max(rows.length - 1, 0)),
      );
      return;
    }

    if (isUpKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setValidationMessage(null);
      setSelectedIndex((currentIndex) => Math.max(currentIndex - 1, 0));
      return;
    }

    if (isEnterKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      submitCurrentSelection();
      return;
    }

    if (isEscapeKey(keyName) && onCancel) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      onCancel();
    }
  });

  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle="single"
      borderColor={cliTheme.borders.active}
      backgroundColor={cliTheme.surfaces.panel}
      paddingX={1}
      paddingY={1}
      gap={1}
    >
      <text fg={cliTheme.accent.primary} attributes={TextAttributes.BOLD}>
        {title}
      </text>
      <text fg={cliTheme.text.primary}>{question}</text>

      {rows.length > 0 ? (
        <box width="100%" flexDirection="column">
          {rows.map((row, index) => {
            const rowColors = getOverlayRowColors(index === safeSelectedIndex);

            return (
              <box
                key={row.value}
                width="100%"
                flexDirection="column"
                paddingX={1}
                backgroundColor={rowColors.backgroundColor}
              >
                <text fg={rowColors.primaryTextColor}>
                  {index + 1}. {row.label}
                </text>
                {row.description ? (
                  <text
                    fg={rowColors.secondaryTextColor}
                    attributes={TextAttributes.DIM}
                  >
                    {row.description}
                  </text>
                ) : null}
              </box>
            );
          })}
        </box>
      ) : null}

      {canShowInput ? (
        <box width="100%" flexDirection="column" gap={1}>
          {selectedRow && !selectedRow.isCustom ? (
            <text fg={cliTheme.text.secondary}>Additional details required</text>
          ) : null}
          <input
            value={customAnswer}
            onChange={(value: string) => {
              setValidationMessage(null);
              setCustomAnswer(value ?? "");
            }}
            placeholder={placeholder}
            width="100%"
            focused
            backgroundColor={cliTheme.overlay.inputSurface}
            textColor={cliTheme.overlay.inputText}
          />
        </box>
      ) : null}

      {validationMessage ? (
        <text fg={cliTheme.semantic.warning}>{validationMessage}</text>
      ) : null}

      <box width="100%" flexDirection="row" justifyContent="space-between">
        <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
          {hintLabel}
        </text>
        <text fg={cliTheme.text.secondary}>{submitLabel}</text>
      </box>
    </box>
  );
}
