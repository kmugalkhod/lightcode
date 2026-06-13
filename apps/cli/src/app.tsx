import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { HelpOverlay } from "./components/help-overlay";
import { CommandPalette } from "./commands/command-palette";
import { searchCommands } from "./commands/command-registry";
import { BACK_SHORTCUT_LABEL, getBinding, normalizeKeyName } from "./commands/keymap";
import { SlashPageMenu } from "./commands/slash-page-menu";
import { getSlashMenuItems } from "./commands/slash-menu-items";
import { getPathFromAction } from "./navigation/route-registry";
import { ChatScreen } from "./screens/chat-screen";
import { DiagnosticsScreen } from "./screens/diagnostics-screen";
import { HomeScreen } from "./screens/home-screen";
import { ModelScreen } from "./screens/model-screen";
import { ModelSelectScreen } from "./screens/model-select-screen";
import { OnboardingScreen } from "./screens/onboarding-screen";
import { SessionListScreen } from "./screens/session-list-screen";
import { AppStateProvider, useAppState } from "./state/app-state";
import { useConfigBadge } from "./hooks/use-config-badge";
import { cliTheme } from "./ui/cli-theme";
import { copyText } from "./lib/clipboard";
import {
  isBackspaceKey as isBackspaceKeyName,
  isDownKey as isDownKeyName,
  isEnterKey as isEnterKeyName,
  isEscapeKey as isEscapeKeyName,
  isUpKey as isUpKeyName,
} from "./utils/key-utils";

interface KeyboardEventLike {
  name: string;
  sequence?: string;
  ctrl?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

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

  if (pathname === "/model-info") {
    return "model";
  }

  if (pathname === "/model") {
    return "model-select";
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
    requestChatAction,
    configRefreshNonce,
    toggleToolOutputExpansion,
  } = useAppState();
  const [helpOpen, setHelpOpen] = useState(false);

  // Smart Ctrl+C: copy a selection if there is one, otherwise arm a
  // "press again to exit" hint that quits on a second press within the window.
  const [ctrlCNotice, setCtrlCNotice] = useState<string | null>(null);
  const ctrlCArmedRef = useRef(false);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showCtrlCNotice = (text: string) => {
    setCtrlCNotice(text);
    if (ctrlCTimerRef.current) {
      clearTimeout(ctrlCTimerRef.current);
    }
    ctrlCTimerRef.current = setTimeout(() => {
      setCtrlCNotice(null);
      ctrlCArmedRef.current = false;
      ctrlCTimerRef.current = null;
    }, 2000);
  };

  const handleCtrlC = () => {
    const selection = renderer.getSelection();
    const selectedText = selection ? selection.getSelectedText() : "";

    if (selectedText.trim().length > 0) {
      void copyText(renderer, selectedText);
      renderer.clearSelection();
      ctrlCArmedRef.current = false;
      showCtrlCNotice(`Copied ${selectedText.length} chars to clipboard`);
      return;
    }

    if (ctrlCArmedRef.current) {
      renderer.destroy();
      return;
    }

    ctrlCArmedRef.current = true;
    showCtrlCNotice("Press Ctrl+C again to exit");
  };

  useEffect(() => {
    return () => {
      if (ctrlCTimerRef.current) {
        clearTimeout(ctrlCTimerRef.current);
      }
    };
  }, []);

  const canGoBack = location.pathname !== "/" && location.pathname !== "/home";
  const currentView = getCurrentViewLabel(location.pathname);
  const inChatSession = location.pathname.startsWith("/sessions/");
  const inputHostsSlashMenu =
    location.pathname === "/" ||
    location.pathname === "/home" ||
    inChatSession;

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
      case "system:help":
        setHelpOpen((open) => !open);
        break;
      case "system:toggleToolOutput":
        toggleToolOutputExpansion();
        break;
      case "system:cancel":
        if (helpOpen) {
          setHelpOpen(false);
        } else if (paletteOpen) {
          closePalette();
        } else if (canGoBack) {
          navigate(-1);
        }
        break;
    }
  };

  const filteredCommands = searchCommands(paletteQuery.trim());
  const filteredSlashRoutes = getSlashMenuItems(slashMenuQuery, {
    includeChatActions: inChatSession,
  });
  const selectedSlashRouteIndex = Math.min(
    slashMenuSelected,
    Math.max(filteredSlashRoutes.length - 1, 0),
  );

  const isDownKey = (keyEvent: KeyboardEventLike) =>
    isDownKeyName(keyEvent.name, { vim: !keyEvent.ctrl });

  const isUpKey = (keyEvent: KeyboardEventLike) =>
    isUpKeyName(keyEvent.name, { vim: !keyEvent.ctrl });

  const isEnterKey = (keyEvent: KeyboardEventLike) =>
    isEnterKeyName(keyEvent.name);

  const isEscapeKey = (keyEvent: KeyboardEventLike) =>
    isEscapeKeyName(keyEvent.name);

  const isBackspaceKey = (keyEvent: KeyboardEventLike) =>
    isBackspaceKeyName(keyEvent.name, keyEvent.sequence);

  const captureKeyEvent = (keyEvent: KeyboardEventLike) => {
    keyEvent.preventDefault?.();
    keyEvent.stopPropagation?.();
  };

  const handlePaletteKeyDown = (keyEvent: KeyboardEventLike) => {
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

  const handleSlashMenuKeyDown = (keyEvent: KeyboardEventLike) => {
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
      const item = filteredSlashRoutes[selectedSlashRouteIndex];
      if (item) {
        if ("path" in item) {
          navigate(item.path);
        } else {
          requestChatAction(item.id);
        }
        closeSlashMenu();
      }
    } else if (isEscapeKey(keyEvent)) {
      captureKeyEvent(keyEvent);
      closeSlashMenu();
    }
  };

  useKeyboard((keyEvent) => {
    // Ctrl+C is handled first, regardless of any open menu, so copy / quit
    // always behaves consistently.
    if (keyEvent.ctrl && keyEvent.name === "c") {
      handleCtrlC();
      return;
    }

    if (slashMenuOpen) {
      handleSlashMenuKeyDown(keyEvent);
      return;
    }

    if (paletteOpen) {
      handlePaletteKeyDown(keyEvent);
      return;
    }

    const normalizedKey = normalizeKeyName(keyEvent.name, keyEvent.ctrl, false, false);

    if (isEscapeKey(keyEvent)) {
      handleAction("system:cancel");
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

  const configBadge = useConfigBadge(configRefreshNonce);
  const needsOnboarding =
    configBadge.status === "available" &&
    configBadge.missingCredentialHints.length > 0;

  useEffect(() => {
    if (needsOnboarding && location.pathname !== "/onboarding") {
      navigate("/onboarding");
    }
  }, [location.pathname, navigate, needsOnboarding]);

  const getFooterStatus = () => {
    if (slashMenuOpen) {
      return "Slash pages open | Enter Open | Backspace Close | Esc Cancel";
    }

    const backHint = canGoBack ? ` | Esc/${BACK_SHORTCUT_LABEL} Back` : "";
    return "/ Pages | Ctrl+P Cmd | F1 Help | Ctrl+C Quit" + backHint;
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
          <Route path="/model-info" element={<ModelScreen />} />
          <Route path="/model" element={<ModelSelectScreen />} />
          <Route path="/onboarding" element={<OnboardingScreen />} />
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
        {helpOpen ? (
          <box position="absolute" top={1} left={4} right={4} zIndex={30}>
            <HelpOverlay />
          </box>
        ) : null}
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
        <text fg={ctrlCNotice ? cliTheme.semantic.warning : cliTheme.text.muted}>
          {ctrlCNotice ?? getFooterStatus()}
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
