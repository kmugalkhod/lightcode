import { productName } from "@lightcode/shared";
import { cliTheme, space } from "../ui/cli-theme";

const logoColors = Array.from(productName, () => cliTheme.accent.primary);

export function HomeAsciiArt() {
  return (
    <box flexDirection="column" alignItems="center" gap={space.xs}>
      <ascii-font text="lightcode" font="block" color={logoColors} />
      <text fg={cliTheme.text.secondary}>Agentic coding in your terminal</text>
    </box>
  );
}
