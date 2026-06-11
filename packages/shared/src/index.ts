export * from "./data-dir";
export * from "./error-utils";
export * from "./logger";
export * from "./version";

export const productName = "Lightcode";

export function createGreeting(target: string) {
  return `Welcome to ${productName}, ${target}`;
}
