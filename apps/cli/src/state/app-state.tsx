import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Live chat metrics published by the chat screen so the persistent app
 * footer can show them from outside the chat route.
 */
export interface ChatFooterStatus {
  /** Context budget used, 0-100. */
  contextPercentage: number;
  contextLevel: "normal" | "warning" | "critical";
  /** Messages folded into the rolling summary; 0 when uncompacted. */
  compactedMessages: number;
  /** Cumulative session cost in USD; null when pricing is unknown. */
  sessionCostUsd: number | null;
}

export interface AppStateValue {
  /** Live chat metrics for the footer; null when no chat session is open. */
  chatFooterStatus: ChatFooterStatus | null;
  setChatFooterStatus: (status: ChatFooterStatus | null) => void;
  paletteOpen: boolean;
  paletteQuery: string;
  setPaletteQuery: (q: string) => void;
  paletteSelected: number;
  setPaletteSelected: (i: number) => void;
  openPalette: (initialQuery?: string) => void;
  closePalette: () => void;
  slashMenuOpen: boolean;
  slashMenuQuery: string;
  setSlashMenuQuery: (q: string) => void;
  slashMenuSelected: number;
  setSlashMenuSelected: (i: number) => void;
  openSlashMenu: () => void;
  closeSlashMenu: () => void;
  /**
   * Chat action picked in the slash menu (e.g. "compact"). The global key
   * handler owns menu selection, but only the chat screen has the session
   * context to execute it — it watches this value and clears it after running.
   */
  requestedChatActionId: string | null;
  requestChatAction: (id: string) => void;
  clearRequestedChatAction: () => void;
  /** Bumped after onboarding writes config so config consumers refetch. */
  configRefreshNonce: number;
  bumpConfigRefresh: () => void;
  /** Global toggle (Ctrl+O): show full tool outputs in chat. */
  expandedToolOutput: boolean;
  toggleToolOutputExpansion: () => void;
  /** Global toggle (Ctrl+R): show the model's reasoning in chat. */
  expandedReasoning: boolean;
  toggleReasoningExpansion: () => void;
  /**
   * Right-side "Changes" file-explorer panel visibility. Both the F2 keystroke
   * and the clickable header toggle flip this single boolean so they stay in
   * sync. Hidden by default.
   */
  changesPanelOpen: boolean;
  setChangesPanelOpen: (open: boolean) => void;
  toggleChangesPanel: () => void;
  /**
   * True while the in-panel file editor owns the keyboard. The global key
   * handler yields to the focused editor textarea (only Ctrl+C still works) so
   * typing, Esc, and Ctrl+S reach the editor instead of triggering navigation.
   */
  editorActive: boolean;
  setEditorActive: (active: boolean) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteSelected, setPaletteSelected] = useState(0);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuQuery, setSlashMenuQuery] = useState("/");
  const [slashMenuSelected, setSlashMenuSelected] = useState(0);

  const openPalette = useCallback((initialQuery = "") => {
    setPaletteOpen(true);
    setPaletteQuery(initialQuery);
    setPaletteSelected(0);
    setSlashMenuOpen(false);
  }, []);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    setPaletteQuery("");
    setPaletteSelected(0);
  }, []);

  const openSlashMenu = useCallback(() => {
    setSlashMenuOpen(true);
    setSlashMenuQuery("/");
    setSlashMenuSelected(0);
    setPaletteOpen(false);
  }, []);

  const closeSlashMenu = useCallback(() => {
    setSlashMenuOpen(false);
    setSlashMenuQuery("/");
    setSlashMenuSelected(0);
  }, []);

  const [requestedChatActionId, setRequestedChatActionId] = useState<string | null>(null);

  const requestChatAction = useCallback((id: string) => {
    setRequestedChatActionId(id);
  }, []);

  const clearRequestedChatAction = useCallback(() => {
    setRequestedChatActionId(null);
  }, []);

  const [configRefreshNonce, setConfigRefreshNonce] = useState(0);

  const bumpConfigRefresh = useCallback(() => {
    setConfigRefreshNonce((nonce) => nonce + 1);
  }, []);

  const [expandedToolOutput, setExpandedToolOutput] = useState(false);

  const toggleToolOutputExpansion = useCallback(() => {
    setExpandedToolOutput((expanded) => !expanded);
  }, []);

  const [expandedReasoning, setExpandedReasoning] = useState(false);

  const toggleReasoningExpansion = useCallback(() => {
    setExpandedReasoning((expanded) => !expanded);
  }, []);

  const [changesPanelOpen, setChangesPanelOpen] = useState(false);

  const toggleChangesPanel = useCallback(() => {
    setChangesPanelOpen((open) => !open);
  }, []);

  const [editorActive, setEditorActive] = useState(false);

  const [chatFooterStatus, setChatFooterStatus] =
    useState<ChatFooterStatus | null>(null);

  const value = useMemo<AppStateValue>(() => ({
    chatFooterStatus,
    setChatFooterStatus,
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
    requestedChatActionId,
    requestChatAction,
    clearRequestedChatAction,
    configRefreshNonce,
    bumpConfigRefresh,
    expandedToolOutput,
    toggleToolOutputExpansion,
    expandedReasoning,
    toggleReasoningExpansion,
    changesPanelOpen,
    setChangesPanelOpen,
    toggleChangesPanel,
    editorActive,
    setEditorActive,
  }), [
    chatFooterStatus,
    paletteOpen,
    paletteQuery,
    paletteSelected,
    openPalette,
    closePalette,
    slashMenuOpen,
    slashMenuQuery,
    slashMenuSelected,
    openSlashMenu,
    closeSlashMenu,
    requestedChatActionId,
    requestChatAction,
    clearRequestedChatAction,
    configRefreshNonce,
    bumpConfigRefresh,
    expandedToolOutput,
    toggleToolOutputExpansion,
    expandedReasoning,
    toggleReasoningExpansion,
    changesPanelOpen,
    setChangesPanelOpen,
    toggleChangesPanel,
    editorActive,
    setEditorActive,
  ]);

  return (
    <AppStateContext.Provider value={value}>
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState(): AppStateValue {
  const context = useContext(AppStateContext);
  if (!context) {
    throw new Error("useAppState must be used within AppStateProvider");
  }
  return context;
}
