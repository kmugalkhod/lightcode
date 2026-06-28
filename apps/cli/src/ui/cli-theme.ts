import type { BorderStyle } from "@opentui/core";

/** Re-export for consumers that want to use attributes directly */
export { TextAttributes } from "@opentui/core";

export type MessageRole = "user" | "assistant" | "system";

export interface MessageRoleTheme {
  labelColor: string;
  borderColor: string;
  backgroundColor: string;
  /** Single bold glyph shown before the role label in the transcript. */
  glyph: string;
}

export type ToolInvocationState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

export type ToolTone = "muted" | "info" | "warning" | "success" | "error";

export type ToolStateToneMap = Record<ToolInvocationState, ToolTone>;

export interface CliTheme {
  surfaces: {
    base: string;
    panel: string;
    elevated: string;
    inset: string;
  };
  borders: {
    default: string;
    subtle: string;
    active: string;
  };
  text: {
    primary: string;
    secondary: string;
    muted: string;
  };
  accent: {
    primary: string;
    softBackground: string;
    softText: string;
  };
  semantic: {
    success: string;
    warning: string;
    error: string;
    info: string;
  };
  diff: {
    added: string;
    addedBg: string;
    removed: string;
    removedBg: string;
  };
  messageRoles: Record<MessageRole, MessageRoleTheme>;
  overlay: {
    surface: string;
    border: string;
    title: string;
    selectedRowBackground: string;
    selectedRowText: string;
    inputSurface: string;
    inputText: string;
    mutedText: string;
    footerText: string;
    selectedBorder: string;
    badgeBackground: string;
    badgeText: string;
    description: string;
    sectionDivider: string;
    shortcutHint: string;
    headerMuted: string;
    countBadge: string;
    hoverBackground: string;
  };
  input: {
    container: string;
    field: string;
    focusedBorder: string;
    blurredBorder: string;
    placeholder: string;
    text: string;
    cursor: string;
    hint: string;
  };
  scroll: {
    rail: string;
    thumb: string;
    thumbActive: string;
  };
  markdown: {
    tableBorder: string;
  };
  /** Deliberate typographic hierarchy.
   *  These define roles + suggested attributes instead of ad-hoc BOLD/DIM everywhere.
   *  Actual rendering still uses color + TextAttributes from OpenTUI.
   */
  typography: {
    /** Highest: brand or major screen title (once per screen) */
    display: { color: string; attributes: number };
    /** Page or section header title */
    title: { color: string; attributes: number };
    /** Sub-section or subgroup header inside a page */
    section: { color: string; attributes: number };
    /** Inline/field label (e.g. table keys, form labels) */
    label: { color: string; attributes: number };
    /** Default body / paragraph text */
    body: { color: string; attributes: number };
    /** Supporting / secondary body */
    secondary: { color: string; attributes: number };
    /** Smallest / captions, hints, metadata */
    caption: { color: string; attributes: number };
    /** Strong emphasis callouts (amber, errors, etc.) */
    emphasis: { color: string; attributes: number };
  };
}

export const toolStateToneMap = {
  "input-streaming": "muted",
  "input-available": "info",
  "approval-requested": "warning",
  "approval-responded": "info",
  "output-available": "success",
  "output-error": "error",
  "output-denied": "warning",
} satisfies ToolStateToneMap;

export const cliTheme: CliTheme = {
  surfaces: {
    base: "#0D1117",
    panel: "#121820",
    elevated: "#18212B",
    inset: "#10151C",
  },
  borders: {
    default: "#273241",
    subtle: "#202A36",
    active: "#F2A65A",
  },
  text: {
    primary: "#EEF3F8",
    secondary: "#B6C2CF",
    muted: "#7A8796",
  },
  accent: {
    // Warm amber: the single "active / live / you-are-here / brand" accent.
    primary: "#F2A65A",
    softBackground: "#33260F",
    softText: "#F6C99A",
  },
  semantic: {
    success: "#8BD49C",
    // Nudged yellower so it stays distinct from the amber accent.
    warning: "#E5C07B",
    error: "#F28B82",
    info: "#9CBDFD",
  },
  diff: {
    added: "#8BD49C",
    addedBg: "#13271B",
    removed: "#F28B82",
    removedBg: "#2B1619",
  },
  messageRoles: {
    user: {
      labelColor: "#9CBDFD",
      borderColor: "#22314A",
      backgroundColor: "#111A27",
      glyph: "▸",
    },
    assistant: {
      labelColor: "#8BD49C",
      borderColor: "#203A2A",
      backgroundColor: "#111C18",
      glyph: "◆",
    },
    system: {
      labelColor: "#C3CDD9",
      borderColor: "#273241",
      backgroundColor: "#131820",
      glyph: "■",
    },
  },
  overlay: {
    surface: "#121820",
    border: "#273241",
    title: "#F2A65A",
    selectedRowBackground: "#33260F",
    selectedRowText: "#EEF3F8",
    inputSurface: "#10151C",
    inputText: "#EEF3F8",
    mutedText: "#7A8796",
    footerText: "#B6C2CF",
    selectedBorder: "#F2A65A",
    badgeBackground: "#18212B",
    badgeText: "#B6C2CF",
    description: "#9AA8B7",
    sectionDivider: "#202A36",
    shortcutHint: "#9AA8B7",
    headerMuted: "#9AA8B7",
    countBadge: "#33260F",
    hoverBackground: "#18212B",
  },
  input: {
    container: "#121820",
    field: "#10151C",
    focusedBorder: "#F2A65A",
    blurredBorder: "#273241",
    placeholder: "#7A8796",
    text: "#EEF3F8",
    cursor: "#EEF3F8",
    hint: "#9AA8B7",
  },
  scroll: {
    rail: "#0D1117",
    thumb: "#273241",
    thumbActive: "#F2A65A",
  },
  markdown: {
    tableBorder: "#273241",
  },
  typography: {
    /** Display: brand level, used sparingly once per context (e.g. cover title) */
    display: { color: "accent", attributes: 1 /* BOLD */ },
    /** Title: primary page or major section header */
    title: { color: "primary", attributes: 1 /* BOLD */ },
    /** Section: subsection header within a surface */
    section: { color: "secondary", attributes: 1 /* BOLD */ },
    /** Label: row/field labels, table keys */
    label: { color: "muted", attributes: 0 /* NONE */ },
    /** Body: default readable text */
    body: { color: "primary", attributes: 0 },
    /** Secondary: supporting descriptive text */
    secondary: { color: "secondary", attributes: 0 },
    /** Caption: footnotes, hints, meta, dim details */
    caption: { color: "muted", attributes: 2 /* DIM */ },
    /** Emphasis: calls-to-action, active states, strong signals */
    emphasis: { color: "accent", attributes: 1 /* BOLD */ },
  },
};

/**
 * One spacing vocabulary for the whole TUI (in terminal cells). Use these for
 * box `gap`/`padding` instead of ad-hoc margins so layouts stay consistent.
 */
export const space = {
  none: 0,
  xs: 1,
  sm: 1,
  md: 2,
  lg: 3,
} as const;

/**
 * Border style by intent: cards feel soft, modals feel raised, structural chrome
 * stays crisp. Reference the intent, not the literal style, so it stays uniform.
 */
export const borderStyleFor = {
  card: "rounded",
  modal: "heavy",
  chrome: "single",
} as const satisfies Record<string, BorderStyle>;

/**
 * Single source of truth for the small glyph set. `unicode` is used on capable
 * terminals; `ascii` is the fallback for non-UTF-8 locales (wired up in the
 * capability resolver). Color carries meaning — the glyph stays constant.
 */
export const glyphs = {
  unicode: {
    roleUser: "▸",
    roleAssistant: "◆",
    roleSystem: "■",
    toolRunning: "▸",
    toolOk: "✓",
    toolError: "✗",
    toolDenied: "⊘",
    toolApproval: "●",
    statusDot: "●",
    indent: "⎿",
    back: "◀",
    breadcrumb: "›",
    bullet: "·",
  },
  ascii: {
    roleUser: ">",
    roleAssistant: "*",
    roleSystem: "#",
    toolRunning: ">",
    toolOk: "+",
    toolError: "x",
    toolDenied: "/",
    toolApproval: "o",
    statusDot: "o",
    indent: ">",
    back: "<",
    breadcrumb: ">",
    bullet: "-",
  },
} as const;

export type GlyphName = keyof typeof glyphs.unicode;

export function getMessageRoleTheme(role: MessageRole): MessageRoleTheme {
  return cliTheme.messageRoles[role];
}

export function getToolToneColor(state: ToolInvocationState): string {
  const tone = toolStateToneMap[state];

  if (tone === "success") {
    return cliTheme.semantic.success;
  }

  if (tone === "warning") {
    return cliTheme.semantic.warning;
  }

  if (tone === "error") {
    return cliTheme.semantic.error;
  }

  if (tone === "info") {
    return cliTheme.semantic.info;
  }

  return cliTheme.text.muted;
}

export function getOverlayRowColors(selected: boolean): {
  backgroundColor: string;
  primaryTextColor: string;
  secondaryTextColor: string;
  borderColor?: string;
} {
  if (selected) {
    return {
      backgroundColor: cliTheme.overlay.selectedRowBackground,
      primaryTextColor: cliTheme.overlay.selectedRowText,
      secondaryTextColor: cliTheme.overlay.selectedRowText,
      borderColor: cliTheme.overlay.selectedBorder,
    };
  }

  return {
    backgroundColor: "transparent",
    primaryTextColor: cliTheme.text.primary,
    secondaryTextColor: cliTheme.overlay.description,
  };
}

export const serverStatusColors = {
  checking: cliTheme.text.secondary,
  online: cliTheme.semantic.success,
  unhealthy: cliTheme.semantic.warning,
  offline: cliTheme.semantic.error,
} as const;

/** Helpers to resolve typography role values */
export function getTypographyColor(role: keyof CliTheme["typography"]): string {
  const entry = cliTheme.typography[role];
  const ref = entry.color as string;
  if (ref in cliTheme.text) return (cliTheme.text as any)[ref];
  if (ref in cliTheme.accent) return (cliTheme.accent as any)[ref];
  // Fallbacks
  if (ref === "primary") return cliTheme.text.primary;
  if (ref === "secondary") return cliTheme.text.secondary;
  if (ref === "muted") return cliTheme.text.muted;
  if (ref === "accent") return cliTheme.accent.primary;
  return cliTheme.text.primary;
}

export function getTypographyAttributes(role: keyof CliTheme["typography"]): number {
  return cliTheme.typography[role].attributes;
}

/** Convenience tuple for a <text> element */
export function typeRole(role: keyof CliTheme["typography"]): { fg: string; attributes: number } {
  return { fg: getTypographyColor(role), attributes: getTypographyAttributes(role) };
}
