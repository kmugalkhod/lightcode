import { SlashPageMenu } from "../commands/slash-page-menu";
import { ChatTextArea } from "./chat/chat-text-area";
import { getSlashPageRoutes } from "../navigation/route-registry";
import { useAppState } from "../state/app-state";

export function HomeTextArea() {
  const {
    slashMenuOpen,
    slashMenuQuery,
    setSlashMenuQuery,
    slashMenuSelected,
    setSlashMenuSelected,
    submitPrompt,
    navigate,
  } = useAppState();

  const slashRoutes = getSlashPageRoutes(slashMenuQuery);
  const selectedIndex = Math.min(slashMenuSelected, Math.max(slashRoutes.length - 1, 0));

  return (
    <box width="66%" maxWidth={104} minWidth={64}>
      <ChatTextArea
        containerHeight={7}
        allowEmpty
        trimOnSubmit={false}
        placeholder={'Ask anything... "What is the tech stack of this project?"'}
        focused={!slashMenuOpen}
        beforeInput={slashMenuOpen ? (
          <SlashPageMenu
            query={slashMenuQuery}
            setQuery={(query) => {
              setSlashMenuQuery(query);
              setSlashMenuSelected(0);
            }}
            selectedIndex={selectedIndex}
            routes={slashRoutes}
          />
        ) : null}
        onSubmit={(text) => {
          submitPrompt(text);
          navigate("chat", {
            state: {
              input: text,
              sessionId: crypto.randomUUID(),
              skipHistoryLoad: true,
            },
          });
        }}
        footer={(
          <text>
            <span fg="#22D3EE">Build</span>
            <span fg="#8D8D8D"> GPT-5.5 / OpenAI / high</span>
          </text>
        )}
      />
    </box>
  );
}
