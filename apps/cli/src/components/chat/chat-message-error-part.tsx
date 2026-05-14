interface ChatMessageErrorPartProps {
  text: string;
  label?: string;
}

export function ChatMessageErrorPart({
  text,
  label = "Error",
}: ChatMessageErrorPartProps) {
  return (
    <box flexDirection="column">
      <text fg="#F87171">{label}</text>
      <text fg="#FCA5A5">{text}</text>
    </box>
  );
}
