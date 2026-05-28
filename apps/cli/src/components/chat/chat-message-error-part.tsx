import { cliTheme } from "../../ui/cli-theme";

interface ChatMessageErrorPartProps {
  text: string;
  label?: string;
}

export function ChatMessageErrorPart({
  text,
  label = "Error",
}: ChatMessageErrorPartProps) {
  return (
    <text>
      <span fg={cliTheme.semantic.error}>{label}:</span>
      <span fg={cliTheme.text.secondary}> {text}</span>
    </text>
  );
}
