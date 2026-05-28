import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { cliTheme } from "./cli-theme";

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
      backgroundColor={cliTheme.overlay.surface}
      borderStyle="single"
      border={["top", "bottom", "left", "right"]}
      borderColor={cliTheme.overlay.border}
    >
      <box
        paddingX={1}
        paddingY={1}
        borderStyle="single"
        border={["bottom"]}
        borderColor={cliTheme.overlay.border}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg={cliTheme.overlay.title} attributes={TextAttributes.BOLD}>
          {title}
        </text>
      </box>
      <box flexGrow={1} padding={1}>
        {children}
      </box>
    </box>
  );
}
