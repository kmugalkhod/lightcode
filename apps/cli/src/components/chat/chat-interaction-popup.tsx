import { useKeyboard } from "@opentui/react";
import { useMemo, useState } from "react";
import { typeRole, borderStyleFor, cliTheme, getOverlayRowColors } from "../../ui/cli-theme";
import { activeGlyphs } from "../../ui/cli-theme-capabilities";
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

  // With no real options the row list is just the synthetic custom entry —
  // skip the list and show the input directly.
  const inputOnly = options.length === 0 && allowCustomResponse;
  const visibleRows = inputOnly ? [] : rows;

  const safeSelectedIndex = Math.min(selectedIndex, Math.max(rows.length - 1, 0));
  const selectedRow = rows[safeSelectedIndex];

  const requiresCustomResponse = Boolean(
    selectedRow?.isCustom ||
      (selectedRow && requireCustomResponseForValues.includes(selectedRow.value)),
  );

  const canShowInput = inputOnly || requiresCustomResponse;

  const hintLabel = [
    visibleRows.length > 1 ? "↑/↓ select" : null,
    visibleRows.length > 1 ? "1-9 pick" : null,
    `Enter ${submitVerb}`,
    onCancel ? "Esc dismiss" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const submitCurrentSelection = () => {
    if (!selectedRow && !canShowInput) {
      return;
    }

    if (canShowInput) {
      const answer = customAnswer.trim();
      if (answer.length === 0) {
        setValidationMessage(
          selectedRow && !selectedRow.isCustom && !inputOnly
            ? "This choice needs a short note — type it below."
            : "Type an answer first, then press Enter.",
        );
        return;
      }

      setValidationMessage(null);
      onSubmit({
        answer,
        selectedOption:
          selectedRow && !selectedRow.isCustom && !inputOnly
            ? selectedRow.label
            : undefined,
        selectedValue:
          selectedRow && !selectedRow.isCustom && !inputOnly
            ? selectedRow.value
            : undefined,
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

  const selectRow = (index: number) => {
    setValidationMessage(null);
    setSelectedIndex(Math.min(Math.max(index, 0), Math.max(rows.length - 1, 0)));
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
      selectRow(safeSelectedIndex + 1);
      return;
    }

    if (isUpKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      selectRow(safeSelectedIndex - 1);
      return;
    }

    // Quick pick: 1-9 jumps straight to an option (and submits it when it
    // needs no typed follow-up). Disabled while the input is showing so
    // digits type into the answer instead.
    if (!canShowInput && visibleRows.length > 1 && /^[1-9]$/.test(keyName)) {
      const index = Number(keyName) - 1;
      if (index < rows.length) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        selectRow(index);
        const row = rows[index];
        const needsInput =
          row.isCustom || requireCustomResponseForValues.includes(row.value);
        if (!needsInput) {
          setValidationMessage(null);
          onSubmit({
            answer: row.label,
            selectedOption: row.label,
            selectedValue: row.value,
            source: "option",
          });
        }
      }
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
      borderStyle={borderStyleFor.modal}
      borderColor={cliTheme.borders.active}
      backgroundColor={cliTheme.surfaces.panel}
      paddingX={2}
      paddingY={1}
      gap={1}
    >
      <box width="100%" flexDirection="row" justifyContent="space-between">
        <text {...typeRole("title")}>{title}</text>
        <text fg={cliTheme.text.muted}>{submitLabel}</text>
      </box>
      <text fg={cliTheme.text.primary}>{question}</text>

      {visibleRows.length > 0 ? (
        <box width="100%" flexDirection="column">
          {visibleRows.map((row, index) => {
            const selected = index === safeSelectedIndex;
            const rowColors = getOverlayRowColors(selected);

            return (
              <box
                key={row.value}
                width="100%"
                flexDirection="column"
                paddingX={1}
                backgroundColor={rowColors.backgroundColor}
              >
                <text fg={selected ? cliTheme.accent.primary : rowColors.primaryTextColor}>
                  <span>{selected ? `${activeGlyphs.roleUser} ` : "  "}</span>
                  <span fg={selected ? cliTheme.accent.primary : cliTheme.text.muted}>
                    {index + 1}.{" "}
                  </span>
                  <span fg={rowColors.primaryTextColor}>{row.label}</span>
                </text>
                {row.description ? (
                  <text fg={rowColors.secondaryTextColor}>
                    {"     "}
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
          {selectedRow && !selectedRow.isCustom && !inputOnly ? (
            <text fg={cliTheme.text.secondary}>Add a short note to continue:</text>
          ) : null}
          <input
            value={customAnswer}
            onInput={(value: string) => {
              setValidationMessage(null);
              setCustomAnswer(value ?? "");
            }}
            onSubmit={() => {
              submitCurrentSelection();
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

      <text {...typeRole("caption")}>{hintLabel}</text>
    </box>
  );
}
