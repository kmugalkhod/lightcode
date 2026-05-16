import { SlashPageMenu } from "../commands/slash-page-menu";
import { sessionCreateResponseSchema } from "../lib/chat-schema-types";
import { ChatTextArea } from "./chat/chat-text-area";
import { getSlashPageRoutes } from "../navigation/route-registry";
import { useAppState } from "../state/app-state";
import { useState } from "react";
import { useNavigate } from "react-router";

const apiBaseUrl = Bun.env.LIGHTCODE_API_URL ?? "http://localhost:3000";
const sessionsApiUrl = `${apiBaseUrl}/sessions`;

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}

export function HomeTextArea() {
  const navigate = useNavigate();
  const {
    slashMenuOpen,
    slashMenuQuery,
    setSlashMenuQuery,
    slashMenuSelected,
    setSlashMenuSelected,
  } = useAppState();
  const [sessionCreateError, setSessionCreateError] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);

  const slashRoutes = getSlashPageRoutes(slashMenuQuery);
  const selectedIndex = Math.min(slashMenuSelected, Math.max(slashRoutes.length - 1, 0));

  async function createSessionAndNavigate(text: string) {
    const prompt = text.trim();
    if (!prompt) {
      return;
    }

    setSessionCreateError(null);
    setIsCreatingSession(true);

    try {
      const response = await fetch(sessionsApiUrl, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Unable to create a new session (HTTP ${response.status}).`);
      }

      const rawPayload = await response.json();
      const parsedPayload = sessionCreateResponseSchema.safeParse(rawPayload);
      if (!parsedPayload.success) {
        throw new Error("Server returned an invalid session response.");
      }

      navigate(`/sessions/${encodeURIComponent(parsedPayload.data.id)}`, {
        state: {
          input: text,
          skipHistoryLoad: true,
        },
      });
    } catch (sessionCreateFailure) {
      setSessionCreateError(getErrorMessage(sessionCreateFailure, "Unable to create a new session."));
    } finally {
      setIsCreatingSession(false);
    }
  }

  return (
    <box width="66%" maxWidth={104} minWidth={64} flexDirection="column" gap={1}>
      <ChatTextArea
        containerHeight={7}
        allowEmpty
        trimOnSubmit={false}
        placeholder={'Ask anything... "What is the tech stack of this project?"'}
        focused={!slashMenuOpen && !isCreatingSession}
        disabled={isCreatingSession}
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
          void createSessionAndNavigate(text);
        }}
        footer={(
          <text>
            <span fg="#22D3EE">Build</span>
            <span fg="#8D8D8D">{isCreatingSession ? " Creating session..." : " GPT-5.5 / OpenAI / high"}</span>
          </text>
        )}
      />
      {sessionCreateError ? (
        <box paddingX={1}>
          <text fg="#F87171">{sessionCreateError}</text>
        </box>
      ) : null}
    </box>
  );
}
