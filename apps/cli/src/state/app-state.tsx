import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";
import {
  getDefaultRouteState,
  type RouteState,
  type RouteStateByView,
  type ViewId,
} from "../navigation/route-state";

export interface ViewHistoryEntry {
  view: ViewId;
  routeState: RouteState;
}

export interface NavigateOptions<K extends ViewId> {
  addToHistory?: boolean;
  state?: RouteStateByView[K];
}

export interface GenericLayer {
  id: string;
  type: "dialog" | "palette" | "menu";
  component: string;
  props?: Record<string, unknown>;
}

export interface RouteModalLayer {
  id: string;
  type: "route-modal";
  viewId: ViewId;
}

export type Layer = GenericLayer | RouteModalLayer;

export interface LeaderKeyState {
  active: boolean;
  key: string | null;
  timeoutId: NodeJS.Timeout | null;
}

export interface AppStateValue {
  currentView: ViewId;
  currentRouteState: RouteState;
  setCurrentView: (view: ViewId) => void;
  layers: Layer[];
  pushLayer: (layer: Layer) => void;
  popLayer: () => void;
  closeAllLayers: () => void;
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
  openRouteModal: (view: ViewId) => void;
  lastSubmittedPrompt: string | null;
  submitPrompt: (text: string) => void;
  navigate: <K extends ViewId>(view: K, options?: NavigateOptions<K>) => void;
  goBack: () => void;
  viewHistory: ViewHistoryEntry[];
  leaderState: LeaderKeyState;
  activateLeader: (key: string) => void;
  deactivateLeader: () => void;
  setLeaderTimeout: (fn: () => void, ms: number) => void;
  clearLeaderTimeout: () => void;
  whichKeyOpen: boolean;
  openWhichKey: () => void;
  closeWhichKey: () => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [currentView, setCurrentView] = useState<ViewId>("home");
  const [currentRouteState, setCurrentRouteState] = useState<RouteState>(getDefaultRouteState("home"));
  const [viewHistory, setViewHistory] = useState<ViewHistoryEntry[]>([]);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteSelected, setPaletteSelected] = useState(0);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuQuery, setSlashMenuQuery] = useState("/");
  const [slashMenuSelected, setSlashMenuSelected] = useState(0);
  const [lastSubmittedPrompt, setLastSubmittedPrompt] = useState<string | null>(null);
  const [whichKeyOpen, setWhichKeyOpen] = useState(false);

  const [leaderState, setLeaderState] = useState<LeaderKeyState>({
    active: false,
    key: null,
    timeoutId: null,
  });

  const navigate = useCallback(<K extends ViewId>(view: K, options: NavigateOptions<K> = {}) => {
    const addToHistory = options.addToHistory ?? true;

    if (addToHistory && currentView !== view) {
      setViewHistory((prev) => [...prev, { view: currentView, routeState: currentRouteState }]);
    }
    setCurrentView(view);
    setCurrentRouteState(options.state ?? getDefaultRouteState(view));
    setLayers([]);
    setPaletteOpen(false);
    setSlashMenuOpen(false);
    setWhichKeyOpen(false);
    setLeaderState({ active: false, key: null, timeoutId: null });
  }, [currentRouteState, currentView]);

  const goBack = useCallback(() => {
    if (viewHistory.length > 0) {
      const previousEntry = viewHistory[viewHistory.length - 1];
      setViewHistory((prev) => prev.slice(0, -1));
      setCurrentView(previousEntry.view);
      setCurrentRouteState(previousEntry.routeState);
      setLayers([]);
      setPaletteOpen(false);
      setSlashMenuOpen(false);
      setWhichKeyOpen(false);
      setLeaderState({ active: false, key: null, timeoutId: null });
    }
  }, [viewHistory]);

  const pushLayer = useCallback((layer: Layer) => {
    setLayers((prev) => [...prev, layer]);
  }, []);

  const popLayer = useCallback(() => {
    setLayers((prev) => prev.slice(0, -1));
  }, []);

  const closeAllLayers = useCallback(() => {
    setLayers([]);
  }, []);

  const openPalette = useCallback((initialQuery = "") => {
    setPaletteOpen(true);
    setPaletteQuery(initialQuery);
    setPaletteSelected(0);
    setSlashMenuOpen(false);
    setWhichKeyOpen(false);
    setLeaderState({ active: false, key: null, timeoutId: null });
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
    setWhichKeyOpen(false);
    setLeaderState({ active: false, key: null, timeoutId: null });
  }, []);

  const closeSlashMenu = useCallback(() => {
    setSlashMenuOpen(false);
    setSlashMenuQuery("/");
    setSlashMenuSelected(0);
  }, []);

  const openRouteModal = useCallback((view: ViewId) => {
    setLayers((prev) => [
      ...prev,
      {
        id: `route-modal:${view}:${Date.now()}`,
        type: "route-modal",
        viewId: view,
      },
    ]);
    setSlashMenuOpen(false);
    setSlashMenuQuery("/");
    setSlashMenuSelected(0);
    setPaletteOpen(false);
    setWhichKeyOpen(false);
  }, []);

  const submitPrompt = useCallback((text: string) => {
    const submitted = text.trim();
    if (!submitted) {
      return;
    }

    setLastSubmittedPrompt(submitted);
  }, []);

  const activateLeader = useCallback((key: string) => {
    if (leaderState.timeoutId) {
      clearTimeout(leaderState.timeoutId);
    }
    setLeaderState({
      active: true,
      key,
      timeoutId: null,
    });
    setWhichKeyOpen(true);
  }, [leaderState.timeoutId]);

  const deactivateLeader = useCallback(() => {
    if (leaderState.timeoutId) {
      clearTimeout(leaderState.timeoutId);
    }
    setLeaderState({
      active: false,
      key: null,
      timeoutId: null,
    });
    setWhichKeyOpen(false);
  }, [leaderState.timeoutId]);

  const setLeaderTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      fn();
    }, ms);
    setLeaderState((prev) => ({ ...prev, timeoutId: id }));
  }, []);

  const clearLeaderTimeout = useCallback(() => {
    if (leaderState.timeoutId) {
      clearTimeout(leaderState.timeoutId);
      setLeaderState((prev) => ({ ...prev, timeoutId: null }));
    }
  }, [leaderState.timeoutId]);

  const openWhichKey = useCallback(() => {
    setWhichKeyOpen(true);
  }, []);

  const closeWhichKey = useCallback(() => {
    setWhichKeyOpen(false);
  }, []);

  const value = useMemo<AppStateValue>(() => ({
    currentView,
    currentRouteState,
    setCurrentView,
    layers,
    pushLayer,
    popLayer,
    closeAllLayers,
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
    openRouteModal,
    lastSubmittedPrompt,
    submitPrompt,
    navigate,
    goBack,
    viewHistory,
    leaderState,
    activateLeader,
    deactivateLeader,
    setLeaderTimeout,
    clearLeaderTimeout,
    whichKeyOpen,
    openWhichKey,
    closeWhichKey,
  }), [
    currentView, currentRouteState, viewHistory, layers, paletteOpen, paletteQuery, paletteSelected,
    slashMenuOpen, slashMenuQuery, slashMenuSelected, lastSubmittedPrompt, submitPrompt, navigate,
    leaderState, activateLeader, deactivateLeader,
    openSlashMenu, closeSlashMenu, openRouteModal, setLeaderTimeout, clearLeaderTimeout,
    whichKeyOpen, openWhichKey, closeWhichKey
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
