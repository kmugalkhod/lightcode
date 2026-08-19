import type { WorkspaceLocation } from "./api";

export function workspaceLocationName(location: WorkspaceLocation): string {
  return location.name ?? location.label ?? location.pathLabel ?? "Local folder";
}

export function workspaceLocationPath(
  location: WorkspaceLocation,
  segments: readonly string[],
): string {
  return [location.pathLabel ?? workspaceLocationName(location), ...segments].join("/");
}

export function broadWorkspaceRootWarning(location: WorkspaceLocation): string {
  const name = workspaceLocationName(location);
  return `Selecting ${name} lets the agent work inside every folder in ${name}. Choose a project folder for narrower access.`;
}
