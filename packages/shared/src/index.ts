export * from "./data-dir";
export * from "./error-utils";
export * from "./logger";
export * from "./version";

export const productName = "Lightcode";

/**
 * The server's exit code when its port is taken, so the CLI can try the next
 * port instead of treating it like a broken config.
 */
export const SERVER_PORT_IN_USE_EXIT_CODE = 98;

export function createGreeting(target: string) {
  return `Welcome to ${productName}, ${target}`;
}
