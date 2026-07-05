import { TextAttributes, typeRole } from "../ui/cli-theme";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
  sessionDeleteResponseSchema,
  sessionExportJsonSchema,
  sessionForkResponseSchema,
  sessionListResponseSchema,
  sessionSummarySchema,
  type SessionSummary,
} from "@lightcode/ai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { client } from "../lib/client";
import { BACK_SHORTCUT_LABEL } from "../commands/keymap";
import {
  getExportPath,
  sessionToMarkdown,
} from "../commands/export-session-markdown";
import { ChatTextArea } from "../components/chat/chat-text-area";
import { activeGlyphs } from "../ui/cli-theme-capabilities";
import { cliTheme, getOverlayRowColors } from "../ui/cli-theme";
import { isDownKey, isEnterKey, isEscapeKey, isUpKey } from "../utils/key-utils";
import { formatDate, getErrorMessage, truncateInline } from "../utils/text-utils";

function getSessionLabel(session: SessionSummary) {
  return session.title ?? session.latestUserPromptPreview ?? session.id;
}

function sessionMatchesFilter(session: SessionSummary, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return (
    (session.title ?? "").toLowerCase().includes(normalized) ||
    (session.latestUserPromptPreview ?? "").toLowerCase().includes(normalized) ||
    session.id.toLowerCase().includes(normalized)
  );
}

export function SessionListScreen() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);

  const visibleSessions = useMemo(
    () => sessions.filter((session) => sessionMatchesFilter(session, filterQuery)),
    [filterQuery, sessions],
  );
  const safeSelectedIndex = Math.min(
    selectedIndex,
    Math.max(visibleSessions.length - 1, 0),
  );
  const selectedSession = visibleSessions[safeSelectedIndex] ?? null;
  const inputActive = filterOpen || renamingSessionId !== null;

  // Window the list around the selection: rows past the screen edge used to
  // get flex-squeezed to zero height and paint over each other.
  const { height: terminalHeight } = useTerminalDimensions();
  const maxVisibleRows = Math.max(5, terminalHeight - 12);
  const windowStart = Math.max(
    0,
    Math.min(
      safeSelectedIndex - Math.floor(maxVisibleRows / 2),
      visibleSessions.length - maxVisibleRows,
    ),
  );
  const windowedSessions = visibleSessions.slice(
    windowStart,
    windowStart + maxVisibleRows,
  );
  const hiddenAbove = windowStart;
  const hiddenBelow = Math.max(
    0,
    visibleSessions.length - (windowStart + windowedSessions.length),
  );

  const applyLoadedSessions = useCallback(
    (loadedSessions: SessionSummary[], droppedCount: number) => {
      setSessions(loadedSessions);
      setSelectedIndex((currentIndex) =>
        Math.min(currentIndex, Math.max(loadedSessions.length - 1, 0)),
      );
      setErrorMessage(
        droppedCount > 0
          ? `${droppedCount} session${droppedCount === 1 ? "" : "s"} could not be read and ${
              droppedCount === 1 ? "was" : "were"
            } skipped.`
          : null,
      );
    },
    [],
  );

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
      if (parsedPayload.success) {
        applyLoadedSessions(parsedPayload.data.sessions, 0);
        return;
      }

      // A single malformed/legacy row must not blank the whole list — salvage
      // the rows that do parse and report how many were skipped.
      const rawSessions =
        rawPayload &&
        typeof rawPayload === "object" &&
        Array.isArray((rawPayload as { sessions?: unknown }).sessions)
          ? (rawPayload as { sessions: unknown[] }).sessions
          : null;
      if (!rawSessions) {
        throw new Error("Server returned an invalid session list response.");
      }

      const validSessions: SessionSummary[] = [];
      let droppedCount = 0;
      for (const rawSession of rawSessions) {
        const parsedSession = sessionSummarySchema.safeParse(rawSession);
        if (parsedSession.success) {
          validSessions.push(parsedSession.data);
        } else {
          droppedCount += 1;
        }
      }

      applyLoadedSessions(validSessions, droppedCount);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Unable to reach the Lightcode server."));
    } finally {
      setIsLoading(false);
    }
  }, [applyLoadedSessions]);

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

      const exportPath = getExportPath(
        parsedPayload.data.session.title,
        parsedPayload.data.session.id,
      );
      await Bun.write(exportPath, sessionToMarkdown(parsedPayload.data));
      setActionMessage(`Exported Markdown to ${exportPath.replace(/\\/g, "/")}`);
    } catch (error) {
      setActionMessage(getErrorMessage(error, "Unable to export session."));
    }
  }, [selectedSession]);

  const forkSelectedSession = useCallback(async () => {
    if (!selectedSession) {
      setActionMessage("No session selected.");
      return;
    }

    try {
      const response = await client.sessions[":id"].fork.$post({
        param: { id: selectedSession.id },
      });
      if (!response.ok) {
        throw new Error(`Unable to fork session (HTTP ${response.status}).`);
      }

      const parsedPayload = sessionForkResponseSchema.safeParse(
        await response.json(),
      );
      if (!parsedPayload.success) {
        throw new Error("Server returned an invalid fork response.");
      }

      navigate(`/sessions/${encodeURIComponent(parsedPayload.data.id)}`, {
        state: {
          mode: selectedSession.mode,
          permissionMode: selectedSession.permissionMode ?? undefined,
        },
      });
    } catch (error) {
      setActionMessage(getErrorMessage(error, "Unable to fork session."));
    }
  }, [navigate, selectedSession]);

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      setRenamingSessionId(null);

      const trimmedTitle = title.trim();
      if (!trimmedTitle) {
        return;
      }

      try {
        const response = await client.sessions[":id"].$patch({
          param: { id: sessionId },
          json: { title: trimmedTitle },
        });
        if (!response.ok) {
          throw new Error(`Unable to rename session (HTTP ${response.status}).`);
        }

        setActionMessage(`Renamed session to "${trimmedTitle}".`);
        await loadSessions();
      } catch (error) {
        setActionMessage(getErrorMessage(error, "Unable to rename session."));
      }
    },
    [loadSessions],
  );

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useKeyboard((keyEvent) => {
    const keyName = keyEvent.name.toLowerCase();

    if (inputActive) {
      // The inline input owns the keyboard; Esc cancels it.
      if (isEscapeKey(keyName)) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        setFilterOpen(false);
        setFilterQuery("");
        setRenamingSessionId(null);
      }
      return;
    }

    if (isDownKey(keyName, { vim: true })) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setSelectedIndex((currentIndex) =>
        Math.min(currentIndex + 1, Math.max(visibleSessions.length - 1, 0)),
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

    if (isEscapeKey(keyName) && filterQuery) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setFilterQuery("");
      return;
    }

    if (keyName === "l") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      navigate("/sessions/latest");
      return;
    }

    if (keyName === "u") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      void loadSessions();
      return;
    }

    if (keyName === "r") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      if (selectedSession) {
        setRenamingSessionId(selectedSession.id);
      }
      return;
    }

    if (keyName === "f") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      void forkSelectedSession();
      return;
    }

    if (keyName === "/" || keyName === "slash") {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setFilterOpen(true);
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
      return `u refresh · l resume latest · ${BACK_SHORTCUT_LABEL} back`;
    }

    return "Enter resume · r rename · f fork · / filter · e export · d delete · u refresh";
  }, [sessions.length]);

  return (
    <box width="100%" height="100%" flexDirection="column" gap={1}>
      <box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <text {...typeRole("title")}>Sessions</text>
        <text fg={cliTheme.text.muted}>
          {isLoading ? "loading..." : `${sessions.length} saved`}
        </text>
      </box>

      {errorMessage ? (
        <box paddingX={1}>
          <text fg={cliTheme.semantic.error}>{errorMessage}</text>
        </box>
      ) : null}

      {filterQuery && !filterOpen ? (
        <box paddingX={1}>
          <text fg={cliTheme.accent.primary}>
            {`Filter: "${filterQuery}" (${visibleSessions.length} match${
              visibleSessions.length === 1 ? "" : "es"
            }) · Esc clears`}
          </text>
        </box>
      ) : null}

      <box flexDirection="column" flexGrow={1}>
        {visibleSessions.length === 0 && !isLoading ? (
          <box
            flexGrow={1}
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            gap={1}
          >
            <text fg={cliTheme.accent.primary} attributes={TextAttributes.BOLD}>
              {sessions.length === 0 ? `${activeGlyphs.roleAssistant} No sessions yet` : "No matches"}
            </text>
            <text fg={cliTheme.text.muted}>
              {sessions.length === 0
                ? "Go Home and send a message to start your first session."
                : "No sessions match the filter — clear it to see all."}
            </text>
          </box>
        ) : null}

        {hiddenAbove > 0 ? (
          <box paddingX={1} flexShrink={0}>
            <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
              {`↑ ${hiddenAbove} more`}
            </text>
          </box>
        ) : null}
        {windowedSessions.map((session, windowIndex) => {
          const index = windowStart + windowIndex;
          const isSelected = index === safeSelectedIndex;
          const rowColors = getOverlayRowColors(isSelected);
          const selectedForDelete = pendingDeleteId === session.id;

          return (
            <box
              key={session.id}
              flexDirection="column"
              paddingX={1}
              flexShrink={0}
              backgroundColor={rowColors.backgroundColor}
            >
              <box flexDirection="row" justifyContent="space-between">
                <box flexShrink={1} height={1} overflow="hidden">
                  <text
                    wrapMode="none"
                    truncate
                    fg={
                      selectedForDelete
                        ? cliTheme.semantic.error
                        : rowColors.primaryTextColor
                    }
                    attributes={TextAttributes.BOLD}
                  >
                    {isSelected ? `${activeGlyphs.roleUser} ` : "  "}{index + 1}. {truncateInline(getSessionLabel(session), 64)}
                  </text>
                </box>
                <text
                  wrapMode="none"
                  truncate
                  flexShrink={0}
                  fg={rowColors.secondaryTextColor}
                  attributes={TextAttributes.DIM}
                >
                  {`${session.messageCount} msgs · ${session.mode} · ${formatDate(session.updatedAt)}`}
                </text>
              </box>
              {isSelected && session.latestUserPromptPreview ? (
                <text
                  wrapMode="none"
                  truncate
                  fg={rowColors.secondaryTextColor}
                  attributes={TextAttributes.DIM}
                >
                  {"    "}
                  {truncateInline(session.latestUserPromptPreview, 110)}
                </text>
              ) : null}
            </box>
          );
        })}
        {hiddenBelow > 0 ? (
          <box paddingX={1} flexShrink={0}>
            <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
              {`↓ ${hiddenBelow} more`}
            </text>
          </box>
        ) : null}
      </box>

      {actionMessage ? (
        <box paddingX={1}>
          <text fg={cliTheme.semantic.info}>{actionMessage}</text>
        </box>
      ) : null}

      {filterOpen ? (
        <ChatTextArea
          placeholder="Filter sessions..."
          allowEmpty
          onTextChange={setFilterQuery}
          onSubmit={() => setFilterOpen(false)}
        />
      ) : null}

      {renamingSessionId !== null ? (
        <ChatTextArea
          placeholder="New session title..."
          onSubmit={(title) => void renameSession(renamingSessionId, title)}
        />
      ) : null}

      <box paddingX={1}>
        <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
          {inputActive
            ? "Enter confirm · Esc cancel"
            : footerText}
        </text>
      </box>
    </box>
  );
}
