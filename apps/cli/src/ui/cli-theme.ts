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
    base: "#0B0D12",
    panel: "#12161E",
    elevated: "#171C25",
    inset: "#0F141C",
  },
  borders: {
    default: "#222935",
    subtle: "#2B3340",
    active: "#7DD3FC",
  },
  text: {
    primary: "#E6ECF3",
    secondary: "#A3AFBE",
    muted: "#7E8A99",
  },
  accent: {
    primary: "#7DD3FC",
    softBackground: "#183142",
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
      borderColor: "#30455F",
      backgroundColor: "#121B29",
    },
    assistant: {
      labelColor: "#A9D9BA",
      borderColor: "#2B4A3C",
      backgroundColor: "#111D19",
    },
    system: {
      labelColor: "#B1BBC8",
      borderColor: "#343A45",
      backgroundColor: "#181B20",
    },
  },
  overlay: {
    surface: "#12161E",
    border: "#2B3340",
    title: "#7DD3FC",
    selectedRowBackground: "#183142",
    selectedRowText: "#D9F3FF",
    inputSurface: "#171C25",
    inputText: "#E6ECF3",
    mutedText: "#7E8A99",
    footerText: "#7E8A99",
  },
  input: {
    container: "#12161E",
    field: "#171C25",
    focusedBorder: "#7DD3FC",
    blurredBorder: "#2B3340",
    placeholder: "#7E8A99",
    text: "#E6ECF3",
    cursor: "#E6ECF3",
    hint: "#7E8A99",
  },
  scroll: {
    rail: "#0B0D12",
    thumb: "#2B3340",
    thumbActive: "#7DD3FC",
  },
  markdown: {
    tableBorder: "#2B3340",
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
} {
  if (selected) {
    return {
      backgroundColor: cliTheme.overlay.selectedRowBackground,
      primaryTextColor: cliTheme.overlay.selectedRowText,
      secondaryTextColor: cliTheme.overlay.selectedRowText,
    };
  }

  return {
    backgroundColor: "transparent",
    primaryTextColor: cliTheme.text.primary,
    secondaryTextColor: cliTheme.text.muted,
  };
}

export const serverStatusColors = {
  checking: cliTheme.text.secondary,
  online: cliTheme.semantic.success,
  unhealthy: cliTheme.semantic.warning,
  offline: cliTheme.semantic.error,
} as const;
