export type MessageRole = "user" | "assistant" | "system";

export interface MessageRoleTheme {
  labelColor: string;
  borderColor: string;
  backgroundColor: string;
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
    active: "#80D0C7",
  },
  text: {
    primary: "#EEF3F8",
    secondary: "#B6C2CF",
    muted: "#7A8796",
  },
  accent: {
    primary: "#80D0C7",
    softBackground: "#17333A",
    softText: "#BCEDE8",
  },
  semantic: {
    success: "#8BD49C",
    warning: "#F1C27D",
    error: "#F28B82",
    info: "#9CBDFD",
  },
  messageRoles: {
    user: {
      labelColor: "#9CBDFD",
      borderColor: "#22314A",
      backgroundColor: "#111A27",
    },
    assistant: {
      labelColor: "#8BD49C",
      borderColor: "#203A2A",
      backgroundColor: "#111C18",
    },
    system: {
      labelColor: "#C3CDD9",
      borderColor: "#273241",
      backgroundColor: "#131820",
    },
  },
  overlay: {
    surface: "#121820",
    border: "#273241",
    title: "#80D0C7",
    selectedRowBackground: "#17333A",
    selectedRowText: "#EEF3F8",
    inputSurface: "#10151C",
    inputText: "#EEF3F8",
    mutedText: "#7A8796",
    footerText: "#B6C2CF",
    selectedBorder: "#80D0C7",
    badgeBackground: "#18212B",
    badgeText: "#B6C2CF",
    description: "#9AA8B7",
    sectionDivider: "#202A36",
    shortcutHint: "#9AA8B7",
    headerMuted: "#9AA8B7",
    countBadge: "#17333A",
    hoverBackground: "#18212B",
  },
  input: {
    container: "#121820",
    field: "#10151C",
    focusedBorder: "#80D0C7",
    blurredBorder: "#273241",
    placeholder: "#7A8796",
    text: "#EEF3F8",
    cursor: "#EEF3F8",
    hint: "#9AA8B7",
  },
  scroll: {
    rail: "#0D1117",
    thumb: "#273241",
    thumbActive: "#80D0C7",
  },
  markdown: {
    tableBorder: "#273241",
  },
};

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
