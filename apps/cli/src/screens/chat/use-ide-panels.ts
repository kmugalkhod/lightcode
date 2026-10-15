import type { KeyEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileViewMode, PanelTab } from "../../components/chat/explorer-shared";
import {
  useChangedFiles,
  type ChangedFileChangeKind,
} from "../../components/chat/use-changed-files";
import { useFileContent } from "../../components/chat/use-file-content";
import { useFileTree } from "../../components/chat/use-file-tree";
import { useGitChanges } from "../../components/chat/use-git-changes";
import { isDownKey, isEnterKey, isEscapeKey, isUpKey } from "../../utils/key-utils";

/**
 * State and keyboard handling for the IDE panels (Explorer/Changes, the
 * editor pane, and the narrow-terminal drawer). The chat screen renders them
 * and routes keys here first while the panel holds focus.
 */
export function useIdePanels({
  changesPanelOpen,
  setChangesPanelOpen,
  sessionCwd,
  isStreaming,
  messages,
  setEditorActive,
}: {
  changesPanelOpen: boolean;
  setChangesPanelOpen: (open: boolean) => void;
  sessionCwd: string;
  isStreaming: boolean;
  messages: UIMessage[];
  setEditorActive: (active: boolean) => void;
}) {
  // IDE layout (Explorer | Editor | Chat). The three panes need a wide terminal;
  // below this width F2 opens a single-column drawer over the chat instead.
  const MIN_WIDTH_FOR_PANEL = 100;
  const { width: terminalWidth } = useTerminalDimensions();
  const panelFitsTerminal = terminalWidth >= MIN_WIDTH_FOR_PANEL;
  const panelVisible = changesPanelOpen;
  const narrowDrawer = panelVisible && !panelFitsTerminal;

  // Real git working-tree changes drive the Changes tab + the tree markers.
  const gitChanges = useGitChanges({ cwd: sessionCwd, enabled: panelVisible });
  const changesFiles = gitChanges.files;
  const changedByPath = useMemo(() => {
    const map = new Map<string, ChangedFileChangeKind>();
    for (const file of changesFiles) {
      map.set(file.path, file.changeKind);
    }
    return map;
  }, [changesFiles]);
  // Files the agent edited this session — used only for a small "agent" badge.
  const agentChangedFiles = useChangedFiles(messages);
  const agentTouched = useMemo(
    () => new Set(agentChangedFiles.map((file) => file.path)),
    [agentChangedFiles],
  );

  // Changes-panel selection + focus. Selection is lifted here (not in the panel)
  // so the keyboard handler can drive it; the panel is presentational.
  const [selectedChangedPath, setSelectedChangedPath] = useState<string | null>(null);
  const [changedSelectionPinned, setChangedSelectionPinned] = useState(false);
  const [panelFocused, setPanelFocused] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>("files");
  const [fileView, setFileView] = useState<FileViewMode>("content");
  // "browse" = read-only viewer; "edit" = the file is open in the editable buffer.
  const [panelMode, setPanelMode] = useState<"browse" | "edit">("browse");
  const [fileReloadToken, setFileReloadToken] = useState(0);

  // Editor-style project file tree (Files tab) + open-file tabs.
  const fileTree = useFileTree({
    cwd: sessionCwd,
    enabled: panelVisible && panelTab === "files",
  });
  // Open editor tabs (like an IDE). `activeFilePath` is the one shown.
  const MAX_OPEN_TABS = 8;
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const openFileContent = useFileContent(
    activeFilePath,
    sessionCwd,
    fileReloadToken,
  );

  const isEditingFile = panelMode === "edit";

  const openFileTab = useCallback((path: string) => {
    setOpenFiles((current) =>
      current.includes(path) ? current : [...current, path].slice(-MAX_OPEN_TABS),
    );
    setActiveFilePath(path);
  }, []);

  // Selecting a file in the tree opens (or focuses) its tab.
  useEffect(() => {
    if (fileTree.openFilePath) {
      openFileTab(fileTree.openFilePath);
    }
  }, [fileTree.openFilePath, openFileTab]);

  const selectFileTab = useCallback((path: string) => {
    setPanelMode("browse");
    setActiveFilePath(path);
  }, []);

  const closeFileTab = useCallback((path: string) => {
    setPanelMode("browse");
    setOpenFiles((current) => {
      const index = current.indexOf(path);
      if (index === -1) {
        return current;
      }
      const next = current.filter((file) => file !== path);
      setActiveFilePath((active) => {
        if (active !== path) {
          return active;
        }
        // Activate the nearest remaining tab.
        return next[index] ?? next[index - 1] ?? null;
      });
      return next;
    });
  }, []);

  const switchTab = useCallback(
    (delta: number) => {
      setActiveFilePath((current) => {
        if (openFiles.length === 0) {
          return current;
        }
        const index = current ? openFiles.indexOf(current) : -1;
        const base = index === -1 ? 0 : index;
        const nextIndex = (base + delta + openFiles.length) % openFiles.length;
        return openFiles[nextIndex] ?? current;
      });
    },
    [openFiles],
  );

  // Keep the global key handler in sync so it yields to the focused editor.
  useEffect(() => {
    setEditorActive(isEditingFile);
    return () => setEditorActive(false);
  }, [isEditingFile, setEditorActive]);

  // Leave edit mode automatically when the panel hides, the tab changes, or no
  // file is active.
  useEffect(() => {
    if (!panelVisible || panelTab !== "files" || !activeFilePath) {
      setPanelMode("browse");
    }
  }, [panelVisible, panelTab, activeFilePath]);

  const exitFileEdit = useCallback(() => setPanelMode("browse"), []);
  const enterFileEdit = useCallback(() => {
    const content = openFileContent;
    if (
      activeFilePath &&
      content.path === activeFilePath &&
      !content.loading &&
      !content.error
    ) {
      setPanelMode("edit");
    }
  }, [activeFilePath, openFileContent]);
  const handleFileSaved = useCallback(() => {
    // Re-read the file so the read-only view reflects the saved content, and
    // refresh git so the new change appears in the Changes tab / tree markers.
    setFileReloadToken((token) => token + 1);
    gitChanges.refresh();
  }, [gitChanges]);

  // Auto-refresh git changes when the assistant finishes a turn (it likely
  // edited files). Separate from the context-state refresh effect so it sits
  // after gitChanges is declared.
  const wasStreamingForGitRef = useRef(false);
  useEffect(() => {
    if (wasStreamingForGitRef.current && !isStreaming && panelVisible) {
      gitChanges.refresh();
    }
    wasStreamingForGitRef.current = isStreaming;
  }, [isStreaming, panelVisible, gitChanges]);

  const toggleFileView = useCallback(() => {
    setFileView((view) => (view === "content" ? "diff" : "content"));
  }, []);

  // When the active file changes, default the editor view: changed files open
  // straight to their git diff (git-GUI style), everything else to content.
  const activeFilePathRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeFilePath !== activeFilePathRef.current) {
      activeFilePathRef.current = activeFilePath;
      const isChangedFile =
        activeFilePath !== null &&
        changesFiles.some((file) => file.path === activeFilePath);
      setFileView(isChangedFile ? "diff" : "content");
    }
  }, [activeFilePath, changesFiles]);

  // Default-select the first changed file when nothing valid is selected yet
  // (unless the user pinned a selection).
  useEffect(() => {
    if (changedSelectionPinned || changesFiles.length === 0) {
      return;
    }
    setSelectedChangedPath((current) => {
      if (current && changesFiles.some((file) => file.path === current)) {
        return current;
      }
      return changesFiles[0]!.path;
    });
  }, [changedSelectionPinned, changesFiles]);

  // Lazily load the git diff for whatever file is in focus (Changes selection or
  // the file open in the Files tab).
  useEffect(() => {
    if (selectedChangedPath) {
      gitChanges.requestDiff(selectedChangedPath);
    }
  }, [selectedChangedPath, gitChanges]);
  useEffect(() => {
    if (activeFilePath) {
      gitChanges.requestDiff(activeFilePath);
    }
  }, [activeFilePath, gitChanges]);

  // Drop focus (and any pin) whenever the panel is hidden so reopening starts
  // clean and the input regains focus.
  useEffect(() => {
    if (!panelVisible) {
      setPanelFocused(false);
    }
  }, [panelVisible]);

  // The narrow drawer covers the chat, so it takes keyboard focus while open.
  useEffect(() => {
    if (narrowDrawer && !isEditingFile) {
      setPanelFocused(true);
    }
  }, [narrowDrawer, isEditingFile]);

  const selectChangedPath = useCallback((path: string) => {
    setSelectedChangedPath(path);
    setChangedSelectionPinned(true);
  }, []);

  // From the IDE sidebar: selecting a changed file also opens it in the center
  // editor pane, where its full-width diff renders (git-GUI style).
  const openChangedFile = useCallback(
    (path: string) => {
      selectChangedPath(path);
      openFileTab(path);
    },
    [selectChangedPath, openFileTab],
  );

  const moveChangedSelection = useCallback(
    (delta: number) => {
      if (changesFiles.length === 0) {
        return;
      }
      setSelectedChangedPath((current) => {
        const index = changesFiles.findIndex((file) => file.path === current);
        if (index === -1) {
          return changesFiles[0]!.path;
        }
        const nextIndex = Math.min(
          changesFiles.length - 1,
          Math.max(0, index + delta),
        );
        return changesFiles[nextIndex]!.path;
      });
      setChangedSelectionPinned(true);
    },
    [changesFiles],
  );

  // Active-pane focus ring (IDE layout). Exactly one pane carries the amber
  // border at a time, derived from the existing focus/edit state.
  const editorFocused = isEditingFile;
  const explorerFocused = panelFocused && !isEditingFile;
  const chatFocused = panelVisible && !panelFocused && !isEditingFile;

  // Line count of the file shown in the editor — for the status bar (0 unless
  // the active file's content is loaded).
  const activeLineCount =
    activeFilePath &&
    openFileContent.path === activeFilePath &&
    !openFileContent.loading &&
    !openFileContent.error &&
    openFileContent.content
      ? openFileContent.content.split("\n").length
      : 0;

  /** Handles a key while the panel holds focus; true when the panel owned it. */
  function handlePanelKey(keyEvent: KeyEvent): boolean {
    const keyName = keyEvent.name.toLowerCase();
    if (!(panelFocused && panelVisible)) {
      return false;
    }
    const isTab = keyName === "tab" || keyEvent.sequence === "\t";
    const isRight = keyName === "right" || keyName === "l";
    const isLeft = keyName === "left" || keyName === "h";

    // Esc leaves the panel (closing the narrow drawer, which hides the
    // chat); Tab cycles between the Files and Changes tabs.
    if (isEscapeKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setPanelFocused(false);
      if (narrowDrawer) {
        setChangesPanelOpen(false);
      }
      return true;
    }
    if (isTab) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setPanelTab((tab) => (tab === "files" ? "changes" : "files"));
      return true;
    }

    if (panelTab === "files") {
      if (isUpKey(keyName, { vim: true })) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        fileTree.moveSelection(-1);
        return true;
      }
      if (isDownKey(keyName, { vim: true })) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        fileTree.moveSelection(1);
        return true;
      }
      if (isRight) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        fileTree.expandOrEnter();
        return true;
      }
      if (isLeft) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        fileTree.collapseOrParent();
        return true;
      }
      if (isEnterKey(keyName)) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        fileTree.activateSelected();
        return true;
      }
      if (keyName === "d") {
        // Toggle between the file's contents and its diff (changed files).
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        toggleFileView();
        return true;
      }
      if (keyName === "e") {
        // Edit the active file in place (no-op for dirs / unloaded / binary).
        const content = openFileContent;
        const editable =
          activeFilePath !== null &&
          content.path === activeFilePath &&
          !content.loading &&
          !content.error;
        if (editable) {
          keyEvent.preventDefault();
          keyEvent.stopPropagation();
          setPanelMode("edit");
        }
        return true;
      }
      // [ and ] cycle between open editor tabs.
      if (keyName === "[" || keyEvent.sequence === "[") {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        switchTab(-1);
        return true;
      }
      if (keyName === "]" || keyEvent.sequence === "]") {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        switchTab(1);
        return true;
      }
      if (keyName === "w" && !keyEvent.ctrl && activeFilePath) {
        // Close the active tab.
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        closeFileTab(activeFilePath);
        return true;
      }
    } else {
      if (isUpKey(keyName, { vim: true })) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        moveChangedSelection(-1);
        return true;
      }
      if (isDownKey(keyName, { vim: true })) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        moveChangedSelection(1);
        return true;
      }
      if (isEnterKey(keyName)) {
        // Open the selected change in the center editor pane (full-width diff).
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        if (selectedChangedPath) {
          openChangedFile(selectedChangedPath);
        }
        return true;
      }
      if (keyName === "r") {
        // Manual git refresh.
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        gitChanges.refresh();
        return true;
      }
    }

    // Let F2 reach the global handler so it can still toggle visibility;
    // swallow everything else so it can't leak into the transcript.
    if (keyName === "f2") {
      return true;
    }
    return true;
  }

  return {
    activeFilePath,
    activeLineCount,
    agentTouched,
    changedByPath,
    changedSelectionPinned,
    changesFiles,
    chatFocused,
    closeFileTab,
    editorFocused,
    enterFileEdit,
    exitFileEdit,
    explorerFocused,
    fileTree,
    fileView,
    gitChanges,
    handleFileSaved,
    isEditingFile,
    narrowDrawer,
    openChangedFile,
    openFileContent,
    openFiles,
    panelFocused,
    panelTab,
    panelVisible,
    selectFileTab,
    selectedChangedPath,
    setPanelFocused,
    setPanelTab,
    toggleFileView,
    handlePanelKey,
  };
}
