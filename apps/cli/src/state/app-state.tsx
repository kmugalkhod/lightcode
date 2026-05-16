import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface GenericLayer {
  id: string;
  type: "dialog" | "palette" | "menu";
  component: string;
  props?: Record<string, unknown>;
}

export type Layer = GenericLayer;

export interface LeaderKeyState {
  active: boolean;
  key: string | null;
  timeoutId: NodeJS.Timeout | null;
}

export interface AppStateValue {
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
  const [layers, setLayers] = useState<Layer[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteSelected, setPaletteSelected] = useState(0);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuQuery, setSlashMenuQuery] = useState("/");
  const [slashMenuSelected, setSlashMenuSelected] = useState(0);
  const [whichKeyOpen, setWhichKeyOpen] = useState(false);

  const [leaderState, setLeaderState] = useState<LeaderKeyState>({
    active: false,
    key: null,
    timeoutId: null,
  });

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

  const activateLeader = useCallback((key: string) => {
    setLeaderState((prev) => {
      if (prev.timeoutId) {
        clearTimeout(prev.timeoutId);
      }

      return {
        active: true,
        key,
        timeoutId: null,
      };
    });
    setWhichKeyOpen(true);
  }, []);

  const deactivateLeader = useCallback(() => {
    setLeaderState((prev) => {
      if (prev.timeoutId) {
        clearTimeout(prev.timeoutId);
      }

      return {
        active: false,
        key: null,
        timeoutId: null,
      };
    });
    setWhichKeyOpen(false);
  }, []);

  const setLeaderTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      fn();
    }, ms);
    setLeaderState((prev) => ({ ...prev, timeoutId: id }));
  }, []);

  const clearLeaderTimeout = useCallback(() => {
    setLeaderState((prev) => {
      if (prev.timeoutId) {
        clearTimeout(prev.timeoutId);
      }
      return { ...prev, timeoutId: null };
    });
  }, []);

  const openWhichKey = useCallback(() => {
    setWhichKeyOpen(true);
  }, []);

  const closeWhichKey = useCallback(() => {
    setWhichKeyOpen(false);
  }, []);

  const value = useMemo<AppStateValue>(() => ({
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
    leaderState,
    activateLeader,
    deactivateLeader,
    setLeaderTimeout,
    clearLeaderTimeout,
    whichKeyOpen,
    openWhichKey,
    closeWhichKey,
  }), [
    layers,
    pushLayer,
    popLayer,
    closeAllLayers,
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
    leaderState,
    activateLeader,
    deactivateLeader,
    setLeaderTimeout,
    clearLeaderTimeout,
    whichKeyOpen,
    openWhichKey,
    closeWhichKey,
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
