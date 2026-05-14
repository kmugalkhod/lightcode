import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";

interface DialogProps {
  title: string;
  width?: number;
  height?: number;
  children: ReactNode;
  onClose?: () => void;
}

export function Dialog({
  title,
  width = 60,
  height,
  children,
}: DialogProps) {
  return (
    <box
      position="absolute"
      left={`${50 - Math.floor(width / 2)}%`}
      top={height ? `${50 - Math.floor(height / 2)}%` : "20%"}
      width={width}
      height={height}
      flexDirection="column"
      backgroundColor="#1E1E1E"
      borderStyle="single"
      border={["top", "bottom", "left", "right"]}
      borderColor="#67E8F9"
    >
      <box
        paddingX={1}
        paddingY={1}
        borderStyle="single"
        border={["bottom"]}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg="#67E8F9" attributes={TextAttributes.BOLD}>
          {title}
        </text>
      </box>
      <box flexGrow={1} padding={1}>
        {children}
      </box>
    </box>
  );
}