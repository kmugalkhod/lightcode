import { HomeAsciiArt } from "../components/home-ascii-art";
import { HomeTextArea } from "../components/home-text-area";
import { ServerStatus } from "../components/server-status";
import type { ScreenProps } from "../navigation/route-registry";

export function HomeScreen(_props: ScreenProps<"home">) {
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      gap={2}
      paddingX={2}
      paddingY={1}
      backgroundColor="#070A12"
    >
      <HomeAsciiArt />
      <ServerStatus />
      <HomeTextArea />
    </box>
  );
}
