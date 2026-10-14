import type { WorkspaceLocation } from "./api";

export function workspaceLocationName(location: WorkspaceLocation): string {
  return location.name ?? location.label ?? location.pathLabel ?? "Local folder";
}

export function isDrivesLocation(location: WorkspaceLocation): boolean {
  return location.kind === "drives";
}

export function workspaceLocationPath(
  location: WorkspaceLocation,
  segments: readonly string[],
): string {
  if (isDrivesLocation(location)) {
    const [drive, ...rest] = segments;
    return drive
      ? [drive, ...rest].join("\\") + (rest.length === 0 ? "\\" : "")
      : workspaceLocationName(location);
  }
  return [location.pathLabel ?? workspaceLocationName(location), ...segments].join("/");
}

/** Drive roots and the drive list itself can be browsed but never selected. */
export function isSelectableBrowserPath(
  location: WorkspaceLocation,
  segments: readonly string[],
): boolean {
  return !isDrivesLocation(location) || segments.length >= 2;
}

export function broadWorkspaceRootWarning(location: WorkspaceLocation): string {
  const name = workspaceLocationName(location);
  return `Selecting ${name} lets the agent work inside every folder in ${name}. Choose a project folder for narrower access.`;
}
