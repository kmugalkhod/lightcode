import { productName } from "@lightcode/shared";
import { cliTheme } from "../ui/cli-theme";

const logoColors = Array.from(productName, () => cliTheme.accent.primary);

export function HomeAsciiArt() {
  return (
    <box flexDirection="column" alignItems="center">
      <ascii-font text="nightcode" font="block" color={logoColors} />
    </box>
  );
}
