import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import {
  sessionDeleteResponseSchema,
  sessionExportJsonSchema,
  sessionListResponseSchema,
  type SessionSummary,
} from "@lightcode/ai";
import path from "node:path";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { client } from "../lib/client";
import { BACK_SHORTCUT_LABEL } from "../commands/keymap";
import { cliTheme, getOverlayRowColors } from "../ui/cli-theme";
import { isDownKey, isEnterKey, isUpKey } from "../utils/key-utils";
import { formatDate, getErrorMessage, truncateInline } from "../utils/text-utils";

function getSessionLabel(session: SessionSummary) {
  return session.title ?? session.latestUserPromptPreview ?? session.id;
}

export function SessionListScreen() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const safeSelectedIndex = Math.min(
    selectedIndex,
    Math.max(sessions.length - 1, 0),
  );
  const selectedSession = sessions[safeSelectedIndex] ?? null;

  const loadSessions = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const response = await client.sessions.$get();
      if (!response.ok) {
        throw new Error(`Unable to list sessions (HTTP ${response.status}).`);
      }

      const rawPayload = await response.json();
      const parsedPayload = sessionListResponseSchema.safeParse(rawPayload);
      if (!parsedPayload.success) {
        throw new Error("Server returned an invalid session list response.");
      }

      setSessions(parsedPayload.data.sessions);
      setSelectedIndex((currentIndex) =>
        Math.min(currentIndex, Math.max(parsedPayload.data.sessions.length - 1, 0)),
      );
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Unable to list sessions."));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const resumeSelectedSession = useCallback(() => {
    if (!selectedSession) {
      setActionMessage("No session selected.");
      return;
    }

    navigate(`/sessions/${encodeURIComponent(selectedSession.id)}`, {
      state: {
        mode: selectedSession.mode,
        permissionMode: selectedSession.permissionMode ?? undefined,
      },
    });
  }, [navigate, selectedSession]);

  const deleteSelectedSession = useCallback(async () => {
    if (!selectedSession) {
      setActionMessage("No session selected.");
      return;
    }

    if (pendingDeleteId !== selectedSession.id) {
      setPendingDeleteId(selectedSession.id);
      setActionMessage("Press d again to delete this session.");
      return;
    }

    setPendingDeleteId(null);
    setActionMessage(null);

    try {
      const response = await client.sessions[":id"].$delete({
        param: { id: selectedSession.id },
      });
      if (!response.ok) {
        throw new Error(`Unable to delete session (HTTP ${response.status}).`);
      }

      const rawPayload = await response.json();
      const parsedPayload = sessionDeleteResponseSchema.safeParse(rawPayload);
      if (!parsedPayload.success) {
        throw new Error("Server returned an invalid delete response.");
      }

      setActionMessage(
        `Deleted session ${parsedPayload.data.id} (${parsedPayload.data.deletedMessages} messages).`,
      );
      await loadSessions();
    } catch (error) {
      setActionMessage(getErrorMessage(error, "Unable to delete session."));
    }
  }, [loadSessions, pendingDeleteId, selectedSession]);

  const exportSelectedSession = useCallback(async () => {
    if (!selectedSession) {
      setActionMessage("No session selected.");
      return;
    }

    try {
      const response = await client.sessions[":id"].export.$get({
        param: { id: selectedSession.id },
      });
      if (!response.ok) {
        throw new Error(`Unable to export session (HTTP ${response.status}).`);
      }

      const rawPayload = await response.json();
      const parsedPayload = sessionExportJsonSchema.safeParse(rawPayload);
      if (!parsedPayload.success) {
        throw new Error("Server returned an invalid export response.");
      }

      const exportPath = path.join(
        process.cwd(),
        `lightcode-session-${selectedSession.id}.json`,
      );
      await Bun.write(
        exportPath,
        JSON.stringify(parsedPayload.data, null, 2),
      );
      setActionMessage(`Exported JSON to ${exportPath}`);
    } catch (error) {
      setActionMessage(getErrorMessage(error, "Unable to export session."));
    }
  }, [selectedSession]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useKeyboard((keyEvent) => {
    const keyName = keyEvent.name.toLowerCase();

    if (isDownKey(keyName, { vim: true })) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setSelectedIndex((currentIndex) =>
        Math.min(currentIndex + 1, Math.max(sessions.length - 1, 0)),
      );
      setPendingDeleteId(null);
      return;
    }

    if (isUpKey(keyName, { vim: true })) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setSelectedIndex((currentIndex) => Math.max(currentIndex - 1, 0));
      setPendingDeleteId(null);
      return;
    }

    if (isEnterKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      resumeSelectedSession();
      return;
    }

    if (keyName === "l") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      navigate("/sessions/latest");
      return;
    }

    if (keyName === "r") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      void loadSessions();
      return;
    }

    if (keyName === "d") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      void deleteSelectedSession();
      return;
    }

    if (keyName === "e") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      void exportSelectedSession();
    }
  });

  const footerText = useMemo(() => {
    if (sessions.length === 0) {
      return `r refresh | l resume latest | ${BACK_SHORTCUT_LABEL} back`;
    }

    return "Enter resume | l latest | e export JSON | d delete | r refresh";
  }, [sessions.length]);

  return (
    <box width="100%" height="100%" flexDirection="column" gap={1}>
      <box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <text fg={cliTheme.text.primary} attributes={TextAttributes.BOLD}>
          Sessions
        </text>
        <text fg={cliTheme.text.muted}>
          {isLoading ? "loading..." : `${sessions.length} saved`}
        </text>
      </box>

      {errorMessage ? (
        <box paddingX={1}>
          <text fg={cliTheme.semantic.error}>{errorMessage}</text>
        </box>
      ) : null}

      <box flexDirection="column" flexGrow={1} gap={1}>
        {sessions.length === 0 && !isLoading ? (
          <box paddingX={1}>
            <text fg={cliTheme.text.muted}>No saved sessions yet.</text>
          </box>
        ) : null}

        {sessions.map((session, index) => {
          const rowColors = getOverlayRowColors(index === safeSelectedIndex);
          const selectedForDelete = pendingDeleteId === session.id;

          return (
            <box
              key={session.id}
              flexDirection="column"
              paddingX={1}
              paddingY={1}
              backgroundColor={rowColors.backgroundColor}
            >
              <box flexDirection="row" justifyContent="space-between">
                <text
                  fg={
                    selectedForDelete
                      ? cliTheme.semantic.error
                      : rowColors.primaryTextColor
                  }
                  attributes={TextAttributes.BOLD}
                >
                  {index + 1}. {truncateInline(getSessionLabel(session))}
                </text>
                <text fg={rowColors.secondaryTextColor}>
                  {session.mode}
                  {session.permissionMode ? `/${session.permissionMode}` : ""}
                </text>
              </box>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={rowColors.secondaryTextColor} attributes={TextAttributes.DIM}>
                  {session.messageCount} messages | {session.model ?? "model unknown"}
                </text>
                <text fg={rowColors.secondaryTextColor} attributes={TextAttributes.DIM}>
                  {formatDate(session.updatedAt)}
                </text>
              </box>
              {session.latestUserPromptPreview ? (
                <text fg={rowColors.secondaryTextColor} attributes={TextAttributes.DIM}>
                  {truncateInline(session.latestUserPromptPreview, 110)}
                </text>
              ) : null}
            </box>
          );
        })}
      </box>

      {actionMessage ? (
        <box paddingX={1}>
          <text fg={cliTheme.semantic.info}>{actionMessage}</text>
        </box>
      ) : null}

      <box paddingX={1}>
        <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
          {footerText}
        </text>
      </box>
    </box>
  );
}
