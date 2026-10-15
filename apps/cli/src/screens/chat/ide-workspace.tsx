import type { ReactNode } from "react";
import type { PermissionMode } from "@lightcode/ai";
import { ChangesTab } from "../../components/chat/changes-tab";
import { EditorPane } from "../../components/chat/editor-pane";
import { ExplorerTree } from "../../components/chat/explorer-tree";
import { IdeLayout, NarrowPanelDrawer } from "../../components/chat/ide-layout";
import type { ChatActionTone } from "../../commands/chat-slash-actions";
import { borderStyleFor, cliTheme } from "../../ui/cli-theme";
import { TabButton } from "../../ui/components/tab-button";
import type { useIdePanels } from "./use-ide-panels";
import { contextHintLine } from "../../commands/context-keys";

/**
 * Explorer/Changes, the editor pane and the chat column, laid out as the
 * three-pane IDE or, in a narrow terminal, as a drawer over the chat.
 */
export function IdeWorkspace({
  panels,
  chat,
  sessionCwd,
  modeLabel,
  permissionMode,
  notify,
  setChangesPanelOpen,
}: {
  panels: ReturnType<typeof useIdePanels>;
  chat: ReactNode;
  sessionCwd: string;
  modeLabel: string;
  permissionMode: PermissionMode | undefined;
  notify: (text: string, tone?: ChatActionTone) => void;
  setChangesPanelOpen: (open: boolean) => void;
}) {
  const {
    activeFilePath,
    activeLineCount,
    agentTouched,
    changedByPath,
    changedSelectionPinned,
    changesFiles,
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
    selectFileTab,
    selectedChangedPath,
    setPanelFocused,
    setPanelTab,
    toggleFileView,
  } = panels;

  const explorerSidebar = (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      borderStyle={borderStyleFor.card}
      borderColor={explorerFocused ? cliTheme.borders.active : cliTheme.borders.subtle}
      backgroundColor={cliTheme.surfaces.inset}
    >
      <box flexDirection="row" alignItems="center" flexShrink={0} gap={1} paddingX={1}>
        <TabButton label="Explorer" active={panelTab === "files"} onPress={() => setPanelTab("files")} />
        <TabButton
          label={`Changes${changesFiles.length > 0 ? ` ${changesFiles.length}` : ""}`}
          active={panelTab === "changes"}
          onPress={() => setPanelTab("changes")}
        />
      </box>
      <box flexGrow={1} flexDirection="column">
        {panelTab === "files" ? (
          <ExplorerTree tree={fileTree} changedByPath={changedByPath} rootPath={sessionCwd} />
        ) : (
          <ChangesTab
            changedFiles={changesFiles}
            selectedChangePath={selectedChangedPath}
            onSelectChange={openChangedFile}
            stickToNewest={!changedSelectionPinned}
            focused={panelFocused}
            branch={gitChanges.branch}
            ahead={gitChanges.ahead}
            behind={gitChanges.behind}
            loading={gitChanges.loading}
            isRepo={gitChanges.isRepo}
            agentTouched={agentTouched}
            listOnly
          />
        )}
      </box>
    </box>
  );

  const editorCenter = (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      borderStyle={borderStyleFor.card}
      borderColor={editorFocused ? cliTheme.borders.active : cliTheme.borders.subtle}
      backgroundColor={cliTheme.surfaces.inset}
    >
      <EditorPane
        openFiles={openFiles}
        activeFilePath={activeFilePath}
        changedFiles={changesFiles}
        fileContent={openFileContent}
        fileView={fileView}
        onToggleFileView={toggleFileView}
        editing={isEditingFile}
        cwd={sessionCwd}
        onExitEdit={exitFileEdit}
        onSavedEdit={handleFileSaved}
        notify={notify}
        onSelectFileTab={selectFileTab}
        onCloseFileTab={closeFileTab}
        onEnterEdit={enterFileEdit}
      />
    </box>
  );

  if (narrowDrawer) {
    return (
      <NarrowPanelDrawer
        explorer={explorerSidebar}
        editor={editorCenter}
        hint={contextHintLine(panelTab === "files" ? "explorer" : "changes")}
        onClose={() => {
          setPanelFocused(false);
          setChangesPanelOpen(false);
        }}
      />
    );
  }

  return (
    <IdeLayout
      explorer={explorerSidebar}
      editor={editorCenter}
      chat={chat}
      onExitIde={() => setChangesPanelOpen(false)}
      branch={gitChanges.branch}
      ahead={gitChanges.ahead}
      behind={gitChanges.behind}
      activeFilePath={activeFilePath}
      modeLabel={modeLabel}
      permissionMode={permissionMode}
      lineCount={activeLineCount}
    />
  );
}
