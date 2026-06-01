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
    // New professional overlay tokens
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
    base: "#1a1a1a",
    panel: "#252525",
    elevated: "#2d2d2d",
    inset: "#1f1f1f",
  },
  borders: {
    default: "#333333",
    subtle: "#3a3a3a",
    active: "#7DD3FC",
  },
  text: {
    primary: "#E6ECF3",
    secondary: "#A3AFBE",
    muted: "#7E8A99",
  },
  accent: {
    primary: "#7DD3FC",
    softBackground: "#3a3a3a",
    softText: "#D9F3FF",
  },
  semantic: {
    success: "#7BC08B",
    warning: "#D2A45D",
    error: "#D67A7A",
    info: "#8CB4FF",
  },
  messageRoles: {
    user: {
      labelColor: "#A3C8FF",
      borderColor: "#3a4a5f",
      backgroundColor: "#242933",
    },
    assistant: {
      labelColor: "#A9D9BA",
      borderColor: "#3a4a3c",
      backgroundColor: "#212927",
    },
    system: {
      labelColor: "#B1BBC8",
      borderColor: "#3a3a45",
      backgroundColor: "#242428",
    },
  },
  overlay: {
    surface: "#252525",
    border: "#3a3a3a",
    title: "#7DD3FC",
    selectedRowBackground: "#1e3a4a",
    selectedRowText: "#D9F3FF",
    inputSurface: "#2d2d2d",
    inputText: "#E6ECF3",
    mutedText: "#7E8A99",
    footerText: "#7E8A99",
    // Professional overlay tokens
    selectedBorder: "#7DD3FC",
    badgeBackground: "#3a3a3a",
    badgeText: "#A3AFBE",
    description: "#8899A8",
    sectionDivider: "#3a3a3a",
    shortcutHint: "#5a6a78",
    headerMuted: "#5a6a78",
    countBadge: "#4a5568",
    hoverBackground: "#2a2a2a",
  },
  input: {
    container: "#252525",
    field: "#2d2d2d",
    focusedBorder: "#7DD3FC",
    blurredBorder: "#3a3a3a",
    placeholder: "#7E8A99",
    text: "#E6ECF3",
    cursor: "#E6ECF3",
    hint: "#7E8A99",
  },
  scroll: {
    rail: "#1a1a1a",
    thumb: "#3a3a3a",
    thumbActive: "#7DD3FC",
  },
  markdown: {
    tableBorder: "#3a3a3a",
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
