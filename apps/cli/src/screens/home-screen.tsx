import { HomeAsciiArt } from "../components/home-ascii-art";
import { HomeTextArea } from "../components/home-text-area";
import { ServerStatus } from "../components/server-status";
import { cliTheme } from "../ui/cli-theme";

export function HomeScreen() {
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
      backgroundColor={cliTheme.surfaces.base}
    >
      <HomeAsciiArt />
      <ServerStatus />
      <HomeTextArea />
    </box>
  );
}
