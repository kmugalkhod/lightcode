import { productName } from "@lightcode/shared";

const codeStart = productName.toLowerCase().indexOf("code");
const logoColors = Array.from(productName, (_, index) =>
  codeStart >= 0 && index >= codeStart ? "#BAE6FD" : "#67E8F9",
);

export function HomeAsciiArt() {
  return (
    <box flexDirection="column" alignItems="center">
      <ascii-font text={productName.toLowerCase()} font="block" color={logoColors} />
    </box>
  );
}
