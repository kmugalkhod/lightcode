interface NavigationKeyOptions {
  vim?: boolean;
}

function normalizeKeyName(keyName: string): string {
  return keyName.toLowerCase();
}

export function isDownKey(
  keyName: string,
  options: NavigationKeyOptions = {},
): boolean {
  const normalized = normalizeKeyName(keyName);
  return (
    normalized === "down" ||
    normalized === "arrowdown" ||
    (options.vim === true && normalized === "j")
  );
}

export function isUpKey(
  keyName: string,
  options: NavigationKeyOptions = {},
): boolean {
  const normalized = normalizeKeyName(keyName);
  return (
    normalized === "up" ||
    normalized === "arrowup" ||
    (options.vim === true && normalized === "k")
  );
}

export function isEnterKey(keyName: string): boolean {
  const normalized = normalizeKeyName(keyName);
  return normalized === "enter" || normalized === "return";
}

export function isEscapeKey(keyName: string): boolean {
  return normalizeKeyName(keyName) === "escape";
}

export function isBackspaceKey(keyName: string, sequence?: string): boolean {
  if (normalizeKeyName(keyName) === "backspace") {
    return true;
  }
  return sequence === "\b" || sequence === "\x7f";
}
