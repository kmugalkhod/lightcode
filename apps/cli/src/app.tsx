import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { CommandPalette } from "./commands/command-palette";
import { searchCommands } from "./commands/command-registry";
import { keymap, getBinding, isLeaderKey, normalizeKeyName } from "./commands/keymap";
import { WhichKey } from "./commands/which-key";
import { getPathFromAction, getSlashPageRoutes } from "./navigation/route-registry";
import { ChatScreen } from "./screens/chat-screen";
import { HomeScreen } from "./screens/home-screen";
import { AppStateProvider, useAppState } from "./state/app-state";

function getCurrentViewLabel(pathname: string): string {
  if (pathname === "/" || pathname === "/home") {
    return "home";
  }

  if (pathname.startsWith("/sessions/")) {
    return "session";
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
    setSlashMenuQuery,
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

  const isDownKey = (keyEvent: any) =>
    keyEvent.name === "down" || keyEvent.name === "ArrowDown" || (keyEvent.name === "j" && !keyEvent.ctrl);

  const isUpKey = (keyEvent: any) =>
    keyEvent.name === "up" || keyEvent.name === "ArrowUp" || (keyEvent.name === "k" && !keyEvent.ctrl);

  const isEnterKey = (keyEvent: any) =>
    keyEvent.name === "enter" || keyEvent.name === "return" || keyEvent.name === "Enter";

  const isEscapeKey = (keyEvent: any) =>
    keyEvent.name === "escape" || keyEvent.name === "Escape";

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

    if (maxIndex < 0) {
      if (isEscapeKey(keyEvent)) {
        closeSlashMenu();
      }
      return;
    }

    if (isDownKey(keyEvent)) {
      setSlashMenuSelected(Math.min(slashMenuSelected + 1, maxIndex));
    } else if (isUpKey(keyEvent)) {
      setSlashMenuSelected(Math.max(slashMenuSelected - 1, 0));
    } else if (isEnterKey(keyEvent)) {
      const route = filteredSlashRoutes[slashMenuSelected];
      if (route) {
        navigate(route.path);
        closeSlashMenu();
      }
    } else if (isEscapeKey(keyEvent)) {
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

  const getFooterStatus = () => {
    if (leaderState.active) {
      return "Waiting for key...";
    }

    const backHint = canGoBack ? " | Ctrl+H Back" : "";
    return "/ Pages | Ctrl+P Cmd | Esc/q Quit" + backHint;
  };

  return (
    <box flexDirection="column" flexGrow={1}>
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        borderStyle="single"
        border={["bottom"]}
      >
        <text attributes={TextAttributes.BOLD}>Lightcode</text>
        <text attributes={TextAttributes.DIM}>
          {currentView}
        </text>
      </box>

      <box flexGrow={1} padding={1} position="relative">
        <Routes>
          <Route path="/" element={<HomeScreen />} />
          <Route path="/home" element={<Navigate to="/" replace />} />
          <Route path="/sessions/:id" element={<ChatScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        {paletteOpen ? (
          <CommandPalette
            query={paletteQuery}
            setQuery={setPaletteQuery}
            selectedIndex={paletteSelected}
          />
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
      >
        <text attributes={TextAttributes.DIM}>
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
