import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { CommandPalette } from "./commands/command-palette";
import { searchCommands } from "./commands/command-registry";
import { BACK_SHORTCUT_LABEL, keymap, getBinding, isLeaderKey, normalizeKeyName } from "./commands/keymap";
import { SlashPageMenu } from "./commands/slash-page-menu";
import { WhichKey } from "./commands/which-key";
import { getPathFromAction, getSlashPageRoutes } from "./navigation/route-registry";
import { ChatScreen } from "./screens/chat-screen";
import { DiagnosticsScreen } from "./screens/diagnostics-screen";
import { HomeScreen } from "./screens/home-screen";
import { ModelScreen } from "./screens/model-screen";
import { SessionListScreen } from "./screens/session-list-screen";
import { AppStateProvider, useAppState } from "./state/app-state";
import { useConfigBadge } from "./hooks/use-config-badge";
import { cliTheme } from "./ui/cli-theme";

function getCurrentViewLabel(pathname: string): string {
  if (pathname === "/" || pathname === "/home") {
    return "home";
  }

  if (pathname.startsWith("/sessions/")) {
    return "session";
  }

  if (pathname === "/status") {
    return "status";
  }

  if (pathname === "/doctor") {
    return "doctor";
  }

  if (pathname === "/permissions") {
    return "permissions";
  }

  if (pathname === "/sessions") {
    return "sessions";
  }

  if (pathname === "/tools") {
    return "tools";
  }

  if (pathname === "/config") {
    return "config";
  }

  if (pathname === "/model") {
    return "model";
  }

  return pathname;
}

function AppContent() {
  const renderer = useRenderer();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    paletteOpen,
    paletteQuery,
    setPaletteQuery,
    paletteSelected,
    setPaletteSelected,
    openPalette,
    closePalette,
    slashMenuOpen,
    slashMenuQuery,
    slashMenuSelected,
    setSlashMenuSelected,
    openSlashMenu,
    closeSlashMenu,
    layers,
    popLayer,
    leaderState,
    activateLeader,
    deactivateLeader,
    setLeaderTimeout,
    clearLeaderTimeout,
    whichKeyOpen,
    closeWhichKey,
  } = useAppState();

  const canGoBack = location.pathname !== "/" && location.pathname !== "/home";
  const currentView = getCurrentViewLabel(location.pathname);
  const inputHostsSlashMenu =
    location.pathname === "/" ||
    location.pathname === "/home" ||
    location.pathname.startsWith("/sessions/");

  const handleAction = (action: string) => {
    const path = getPathFromAction(action);
    if (path) {
      navigate(path);
      return;
    }

    switch (action) {
      case "system:quit":
        renderer.destroy();
        break;
      case "system:palette":
        openPalette();
        break;
      case "system:slashPalette":
        openSlashMenu();
        break;
      case "system:back":
        if (canGoBack) {
          navigate(-1);
        }
        break;
      case "system:popLayer":
        if (layers.length > 0) {
          popLayer();
        }
        break;
      case "system:cancel":
        if (leaderState.active) {
          deactivateLeader();
        } else if (paletteOpen) {
          closePalette();
        } else if (layers.length > 0) {
          popLayer();
        } else if (canGoBack) {
          navigate(-1);
        }
        break;
    }
  };

  const filteredCommands = searchCommands(paletteQuery.trim());
  const filteredSlashRoutes = getSlashPageRoutes(slashMenuQuery);
  const selectedSlashRouteIndex = Math.min(
    slashMenuSelected,
    Math.max(filteredSlashRoutes.length - 1, 0),
  );

  const isDownKey = (keyEvent: any) =>
    keyEvent.name === "down" || keyEvent.name === "ArrowDown" || (keyEvent.name === "j" && !keyEvent.ctrl);

  const isUpKey = (keyEvent: any) =>
    keyEvent.name === "up" || keyEvent.name === "ArrowUp" || (keyEvent.name === "k" && !keyEvent.ctrl);

  const isEnterKey = (keyEvent: any) =>
    keyEvent.name === "enter" || keyEvent.name === "return" || keyEvent.name === "Enter";

  const isEscapeKey = (keyEvent: any) =>
    keyEvent.name === "escape" || keyEvent.name === "Escape";

  const isBackspaceKey = (keyEvent: any) =>
    keyEvent.name === "backspace" ||
    keyEvent.sequence === "\b" ||
    keyEvent.sequence === "\x7f";

  const captureKeyEvent = (keyEvent: any) => {
    keyEvent.preventDefault?.();
    keyEvent.stopPropagation?.();
  };

  const handlePaletteKeyDown = (keyEvent: any) => {
    const maxIndex = filteredCommands.length - 1;
    if (isDownKey(keyEvent)) {
      setPaletteSelected(Math.min(paletteSelected + 1, maxIndex));
    } else if (isUpKey(keyEvent)) {
      setPaletteSelected(Math.max(paletteSelected - 1, 0));
    } else if (isEnterKey(keyEvent)) {
      const cmd = filteredCommands[paletteSelected];
      if (cmd) {
        handleAction(cmd.id);
        closePalette();
      }
    } else if (isEscapeKey(keyEvent)) {
      closePalette();
    }
  };

  const handleSlashMenuKeyDown = (keyEvent: any) => {
    const maxIndex = filteredSlashRoutes.length - 1;

    if (isBackspaceKey(keyEvent) && !inputHostsSlashMenu && slashMenuQuery.trim().length <= 1) {
      captureKeyEvent(keyEvent);
      closeSlashMenu();
      return;
    }

    if (maxIndex < 0) {
      if (isEscapeKey(keyEvent)) {
        captureKeyEvent(keyEvent);
        closeSlashMenu();
      } else if (isEnterKey(keyEvent)) {
        captureKeyEvent(keyEvent);
      }
      return;
    }

    if (isDownKey(keyEvent)) {
      captureKeyEvent(keyEvent);
      setSlashMenuSelected(Math.min(slashMenuSelected + 1, maxIndex));
    } else if (isUpKey(keyEvent)) {
      captureKeyEvent(keyEvent);
      setSlashMenuSelected(Math.max(slashMenuSelected - 1, 0));
    } else if (isEnterKey(keyEvent)) {
      captureKeyEvent(keyEvent);
      const route = filteredSlashRoutes[selectedSlashRouteIndex];
      if (route) {
        navigate(route.path);
        closeSlashMenu();
      }
    } else if (isEscapeKey(keyEvent)) {
      captureKeyEvent(keyEvent);
      closeSlashMenu();
    }
  };

  useKeyboard((keyEvent) => {
    if (slashMenuOpen) {
      handleSlashMenuKeyDown(keyEvent);
      return;
    }

    if (paletteOpen) {
      handlePaletteKeyDown(keyEvent);
      return;
    }

    const normalizedKey = normalizeKeyName(keyEvent.name, keyEvent.ctrl, false, false);

    if (leaderState.active) {
      clearLeaderTimeout();

      if (isEscapeKey(keyEvent)) {
        deactivateLeader();
        return;
      }

      const sequence = `${leaderState.key} ${keyEvent.name}`;
      const binding = getBinding(sequence);

      if (binding) {
        deactivateLeader();
        closeWhichKey();
        handleAction(binding.action);
        return;
      }

      deactivateLeader();
      closeWhichKey();
      return;
    }

    if (isEscapeKey(keyEvent) && layers.length > 0) {
      popLayer();
      return;
    }

    if (isEscapeKey(keyEvent) || (keyEvent.ctrl && keyEvent.name === "c")) {
      handleAction("system:quit");
      return;
    }

    if (keyEvent.ctrl && keyEvent.name === "[") {
      handleAction("system:popLayer");
      return;
    }

    if (isLeaderKey(keyEvent.name)) {
      activateLeader(keyEvent.name);
      setLeaderTimeout(() => {
        deactivateLeader();
        closeWhichKey();
      }, keymap.leader_timeout);
      return;
    }

    const binding = getBinding(normalizedKey);
    if (binding) {
      handleAction(binding.action);
      return;
    }

    const directBinding = getBinding(keyEvent.name);
    if (directBinding) {
      handleAction(directBinding.action);
    }
  });

  const configBadge = useConfigBadge();

  const getFooterStatus = () => {
    if (leaderState.active) {
      return "Waiting for key...";
    }

    if (slashMenuOpen) {
      return "Slash pages open | Enter Open | Backspace Close | Esc Cancel";
    }

    const backHint = canGoBack ? ` | ${BACK_SHORTCUT_LABEL} Back` : "";
    return "/ Pages | Ctrl+P Cmd | Esc/q Quit" + backHint;
  };

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={cliTheme.surfaces.base}>
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        borderStyle="single"
        border={["bottom"]}
        borderColor={cliTheme.borders.default}
      >
        <box flexDirection="row" gap={2} alignItems="center">
          <text fg={cliTheme.text.primary} attributes={TextAttributes.BOLD}>Lightcode</text>
          {configBadge.status === "available" ? (
            <text fg={cliTheme.text.secondary}>
              | {configBadge.provider} | {configBadge.model}
            </text>
          ) : configBadge.status === "loading" ? (
            <text fg={cliTheme.text.muted}>
              | loading...
            </text>
          ) : (
            <text fg={cliTheme.text.muted}>
              | provider unavailable
            </text>
          )}
        </box>
        <text fg={cliTheme.text.muted}>
          {currentView}
        </text>
      </box>

      <box flexGrow={1} padding={1} position="relative">
        <Routes>
          <Route path="/" element={<HomeScreen />} />
          <Route path="/home" element={<Navigate to="/" replace />} />
          <Route path="/status" element={<DiagnosticsScreen kind="status" />} />
          <Route path="/doctor" element={<DiagnosticsScreen kind="doctor" />} />
          <Route path="/permissions" element={<DiagnosticsScreen kind="permissions" />} />
          <Route path="/sessions" element={<SessionListScreen />} />
          <Route path="/sessions/:id" element={<ChatScreen />} />
          <Route path="/tools" element={<DiagnosticsScreen kind="tools" />} />
          <Route path="/config" element={<DiagnosticsScreen kind="config" />} />
          <Route path="/model" element={<ModelScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        {paletteOpen ? (
          <CommandPalette
            query={paletteQuery}
            setQuery={setPaletteQuery}
            selectedIndex={paletteSelected}
          />
        ) : null}
        {slashMenuOpen && !inputHostsSlashMenu ? (
          <box position="absolute" top={1} left={2} right={2} zIndex={20}>
            <SlashPageMenu
              query={slashMenuQuery}
              selectedIndex={selectedSlashRouteIndex}
              routes={filteredSlashRoutes}
            />
          </box>
        ) : null}
        {whichKeyOpen ? <WhichKey /> : null}
      </box>

      <box
        flexDirection="row"
        justifyContent="center"
        gap={2}
        paddingTop={1}
        paddingBottom={1}
        borderStyle="single"
        border={["top"]}
        borderColor={cliTheme.borders.default}
      >
        <text fg={cliTheme.text.muted}>
          {getFooterStatus()}
        </text>
      </box>
    </box>
  );
}

export function App() {
  return (
    <MemoryRouter initialEntries={["/"]}>
      <AppStateProvider>
        <AppContent />
      </AppStateProvider>
    </MemoryRouter>
  );
}
