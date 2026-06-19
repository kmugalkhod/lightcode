import {
  codingAgentModes,
  cycleCodingAgentMode,
  defaultCodingAgentMode,
  sessionCreateResponseSchema,
} from "@lightcode/ai";
import { useKeyboard } from "@opentui/react";
import { SlashPageMenu } from "../commands/slash-page-menu";
import { client } from "../lib/client";
import { ChatTextArea } from "./chat/chat-text-area";
import { getSlashPageRoutes } from "../navigation/route-registry";
import { useAppState } from "../state/app-state";
import { cliTheme } from "../ui/cli-theme";
import { getErrorMessage } from "../utils/text-utils";
import { useState } from "react";
import { useNavigate } from "react-router";

export function HomeTextArea() {
  const navigate = useNavigate();
  const {
    slashMenuOpen,
    slashMenuQuery,
    setSlashMenuQuery,
    slashMenuSelected,
    setSlashMenuSelected,
    openSlashMenu,
    closeSlashMenu,
  } = useAppState();
  const [sessionCreateError, setSessionCreateError] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [mode, setMode] = useState(defaultCodingAgentMode);

  const slashRoutes = getSlashPageRoutes(slashMenuQuery);
  const selectedIndex = Math.min(slashMenuSelected, Math.max(slashRoutes.length - 1, 0));
  const modeDefinition = codingAgentModes[mode];

  const syncSlashMenuFromInput = (text: string) => {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";

    if (!firstLine.startsWith("/")) {
      if (slashMenuOpen) {
        closeSlashMenu();
      }
      return;
    }

    if (!slashMenuOpen) {
      openSlashMenu();
    }

    setSlashMenuQuery(firstLine);
    setSlashMenuSelected(0);
  };

  useKeyboard((keyEvent) => {
    const keyName = keyEvent.name.toLowerCase();
    const isPlainTab =
      (keyName === "tab" || keyEvent.sequence === "\t") &&
      !keyEvent.ctrl &&
      !keyEvent.meta &&
      !keyEvent.super &&
      !keyEvent.hyper &&
      !keyEvent.shift;
    const isCtrlT =
      keyName === "t" &&
      keyEvent.ctrl &&
      !keyEvent.meta &&
      !keyEvent.super &&
      !keyEvent.hyper &&
      !keyEvent.shift;

    if ((!isPlainTab && !isCtrlT) || slashMenuOpen || isCreatingSession) {
      return;
    }

    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    setMode((currentMode) => cycleCodingAgentMode(currentMode));
  });

  async function createSessionAndNavigate(text: string) {
    const prompt = text.trim();
    if (!prompt) {
      return;
    }

    setSessionCreateError(null);
    setIsCreatingSession(true);

    try {
      const response = await client.sessions.$post({
        json: {
          cwd: process.cwd(),
          mode,
        },
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
          mode,
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
        focused={!isCreatingSession}
        disabled={isCreatingSession}
        slashMenuOpen={slashMenuOpen}
        onTextChange={syncSlashMenuFromInput}
        beforeInput={slashMenuOpen ? (
          <SlashPageMenu
            query={slashMenuQuery}
            selectedIndex={selectedIndex}
            routes={slashRoutes}
          />
        ) : null}
        onSubmit={(text) => {
          void createSessionAndNavigate(text);
        }}
        footer={
          <box flexDirection="row" justifyContent="space-between">
            <text fg={cliTheme.text.muted}>
              {isCreatingSession ? "Creating session..." : "Tab/Ctrl+T switch mode | Ctrl+P commands"}
            </text>
            <text>
              <span fg={cliTheme.accent.primary}>{modeDefinition.label}</span>
              <span fg={cliTheme.text.muted}> mode</span>
            </text>
          </box>
        }
      />
      {sessionCreateError ? (
        <box paddingX={1}>
          <text fg={cliTheme.semantic.error}>{sessionCreateError}</text>
        </box>
      ) : null}
    </box>
  );
}
