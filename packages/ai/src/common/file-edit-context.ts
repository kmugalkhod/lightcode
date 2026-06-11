/**
 * Optional context for file-mutating tools: when both ids are present, the
 * pre-edit file state is checkpointed so the turn can be undone with /undo.
 */
export interface FileEditContext {
  sessionId?: string;
  turnKey?: string;
}
