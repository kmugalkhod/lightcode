import { useState, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { Dialog } from "./dialog";

interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

interface DialogSelectProps {
  title: string;
  options: SelectOption[];
  onSelect: (value: string) => void;
  onClose: () => void;
}

export function DialogSelect({
  title,
  options,
  onSelect,
  onClose,
}: DialogSelectProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState("");

  const filteredOptions = filter.trim()
    ? options.filter((opt) =>
        opt.label.toLowerCase().includes(filter.toLowerCase()) ||
        opt.value.toLowerCase().includes(filter.toLowerCase())
      )
    : options;

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  useKeyboard((keyEvent) => {
    if (keyEvent.name === "ArrowDown" || keyEvent.name === "j") {
      setSelectedIndex((i) => Math.min(i + 1, filteredOptions.length - 1));
    } else if (keyEvent.name === "ArrowUp" || keyEvent.name === "k") {
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (keyEvent.name === "Enter") {
      if (filteredOptions[selectedIndex]) {
        onSelect(filteredOptions[selectedIndex].value);
      }
    } else if (keyEvent.name === "Escape") {
      onClose();
    }
  });

  return (
    <Dialog title={title} width={70} height={15} onClose={onClose}>
      <box flexDirection="column" flexGrow={1}>
        <input
          value={filter}
          onChange={(value: string) => setFilter(value || "")}
          placeholder="Search..."
          width="100%"
          backgroundColor="#2D2D2D"
          textColor="#FFFFFF"
        />
        <box flexDirection="column" flexGrow={1} marginTop={1}>
          {filteredOptions.map((opt, index) => (
            <box
              key={opt.value}
              flexDirection="column"
              paddingX={1}
              backgroundColor={
                index === selectedIndex ? "#3D3D3D" : "transparent"
              }
            >
              <text fg={index === selectedIndex ? "#67E8F9" : "#FFFFFF"}>
                {opt.label}
              </text>
              {opt.description && (
                <text attributes={TextAttributes.DIM} fg="#8D8D8D">
                  {opt.description}
                </text>
              )}
            </box>
          ))}
        </box>
      </box>
    </Dialog>
  );
}