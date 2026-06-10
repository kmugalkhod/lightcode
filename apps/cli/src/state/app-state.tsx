import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface AppStateValue {
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

  const value = useMemo<AppStateValue>(() => ({
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
  }), [
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
