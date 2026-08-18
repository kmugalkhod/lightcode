import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import {
  lightcodeConfigStatusSchema,
  type LightcodeProvider,
} from "@lightcode/ai";
import {
  isBackspaceKey,
  isDownKey,
  isEnterKey,
  isEscapeKey,
  isUpKey,
} from "../../utils/key-utils";
import { client } from "../../lib/client";
import { useAppState } from "../../state/app-state";
import { borderStyleFor, cliTheme, getOverlayRowColors } from "../../ui/cli-theme";
import { activeGlyphs } from "../../ui/cli-theme-capabilities";

interface ModelSelectorProps {
  onClose: () => void;
  notify: (message: string, tone?: "info" | "error") => void;
}

interface ModelEntry {
  id: string;
  name: string;
  contextLength: number | null;
  supportsTools: boolean;
  supportsReasoning: boolean;
}

const maxVisibleRows = 8;

const providerLabels: Record<LightcodeProvider, string> = {
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI-compatible",
  "opencode-zen": "OpenCode Zen",
  openrouter: "OpenRouter",
};

function providerLabel(provider: LightcodeProvider): string {
  return providerLabels[provider];
}

function formatContextLength(contextLength: number | null) {
  if (!contextLength) {
    return "ctx ?";
  }

  return `ctx ${Math.round(contextLength / 1000)}k`;
}

export function ModelSelector({ onClose, notify }: ModelSelectorProps) {
  const { bumpConfigRefresh } = useAppState();
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [provider, setProvider] = useState<LightcodeProvider | null>(null);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isApplying, setIsApplying] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      try {
        const statusResponse = await client.config.status.$get();

        if (!statusResponse.ok) {
          throw new Error(`Server returned HTTP ${statusResponse.status}`);
        }

        const parsedStatus = lightcodeConfigStatusSchema.safeParse(
          await statusResponse.json(),
        );
        if (!parsedStatus.success) {
          throw new Error("Server returned an invalid configuration status.");
        }

        const status = parsedStatus.data;
        const activeProvider = status.selectedProvider;
        const activeModel = status.selectedModel;

        if (cancelled) {
          return;
        }

        setProvider(activeProvider);
        setCurrentModel(activeModel);

        if (activeProvider !== "openrouter") {
          setModels([
            {
              id: activeModel,
              name: activeModel,
              contextLength: status.contextWindow,
              supportsTools: false,
              supportsReasoning: false,
            },
          ]);
          setCatalogNotice(
            `${providerLabel(activeProvider)} does not expose a model catalog yet. ` +
              "Change its model in settings.json, then restart Lightcode.",
          );
          setIsLoading(false);
          return;
        }

        const modelsResponse = await client.config.models.$get({
          query: { provider: activeProvider },
        });

        if (!modelsResponse.ok) {
          throw new Error(`Server returned HTTP ${modelsResponse.status}`);
        }

        const payload = await modelsResponse.json();
        const loadedModels = ("models" in payload ? payload.models : []) as ModelEntry[];

        if (!cancelled) {
          setModels(loadedModels);
          setCatalogNotice(null);
          setIsLoading(false);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Unable to load models.",
          );
          setIsLoading(false);
        }
      }
    }

    void loadModels();

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredModels = useMemo(() => {
    const normalized = filter.trim().toLowerCase();
    if (!normalized) {
      return models;
    }

    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(normalized) ||
        model.name.toLowerCase().includes(normalized),
    );
  }, [filter, models]);

  useEffect(() => {
    setSelectedIndex((current) =>
      Math.min(current, Math.max(filteredModels.length - 1, 0)),
    );
  }, [filteredModels.length]);

  const applyModel = async (model: ModelEntry) => {
    if (!provider) {
      notify("Model switch failed: active provider is unavailable.", "error");
      return;
    }

    if (model.id === currentModel) {
      notify(`${model.id} is already active for ${providerLabel(provider)}.`);
      onClose();
      return;
    }

    setIsApplying(true);
    try {
      const response = await client.config.model.$put({
        json: { provider, model: model.id },
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Server returned HTTP ${response.status}`);
      }

      notify(
        `Model switched to ${model.id} for ${providerLabel(provider)} (saved to settings.json).`,
      );
      bumpConfigRefresh();
      onClose();
    } catch (error) {
      notify(
        `Model switch failed: ${error instanceof Error ? error.message : "unknown error"}`,
        "error",
      );
      setIsApplying(false);
    }
  };

  useKeyboard((keyEvent) => {
    const keyName = keyEvent.name.toLowerCase();

    if (isEscapeKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      onClose();
      return;
    }

    if (isApplying) {
      return;
    }

    if (isDownKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setSelectedIndex((current) =>
        Math.min(current + 1, Math.max(filteredModels.length - 1, 0)),
      );
      return;
    }

    if (isUpKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setSelectedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (isEnterKey(keyName)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      const selected = filteredModels[selectedIndex];
      if (selected) {
        void applyModel(selected);
      }
      return;
    }

    if (isBackspaceKey(keyName, keyEvent.sequence)) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setFilter((current) => current.slice(0, -1));
      setSelectedIndex(0);
      return;
    }

    // Printable characters extend the filter.
    const sequence = keyEvent.sequence ?? "";
    if (
      sequence.length === 1 &&
      !keyEvent.ctrl &&
      !keyEvent.meta &&
      sequence >= " " &&
      sequence !== "\x7f"
    ) {
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      setFilter((current) => current + sequence);
      setSelectedIndex(0);
    }
  });

  const windowStart = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisibleRows / 2),
      filteredModels.length - maxVisibleRows,
    ),
  );
  const visibleModels = filteredModels.slice(
    windowStart,
    windowStart + maxVisibleRows,
  );

  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle={borderStyleFor.modal}
      borderColor={cliTheme.overlay.border}
      backgroundColor={cliTheme.overlay.surface}
    >
      <box
        width="100%"
        flexDirection="row"
        justifyContent="space-between"
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        border={["bottom"]}
        borderColor={cliTheme.overlay.border}
      >
        <text fg={cliTheme.accent.primary} attributes={TextAttributes.BOLD}>
          {`Switch Model${provider ? ` (${providerLabel(provider)})` : ""}`}
        </text>
        <text fg={cliTheme.overlay.footerText}>
          type to filter · ↑/↓ select · Enter confirm · Esc cancel
        </text>
      </box>

      <box width="100%" paddingX={2} paddingY={1}>
        <text fg={cliTheme.text.primary}>{`Filter: ${filter}█`}</text>
      </box>

      {catalogNotice ? (
        <box paddingX={2} paddingBottom={1}>
          <text fg={cliTheme.semantic.warning}>{catalogNotice}</text>
        </box>
      ) : null}

      {isLoading ? (
        <box paddingX={2} paddingY={1}>
          <text fg={cliTheme.text.muted}>Loading models...</text>
        </box>
      ) : loadError ? (
        <box paddingX={2} paddingY={1}>
          <text fg={cliTheme.semantic.error}>{loadError}</text>
        </box>
      ) : filteredModels.length === 0 ? (
        <box paddingX={2} paddingY={1}>
          <text fg={cliTheme.text.muted}>{`No models match "${filter}".`}</text>
        </box>
      ) : (
        <box flexDirection="column" paddingY={1}>
          {visibleModels.map((model, visibleIndex) => {
            const index = windowStart + visibleIndex;
            const isSelected = index === selectedIndex;
            const rowColors = getOverlayRowColors(isSelected);

            return (
              <box
                key={model.id}
                width="100%"
                flexDirection="row"
                paddingX={2}
                backgroundColor={rowColors.backgroundColor}
              >
                <text
                  width={2}
                  fg={isSelected ? cliTheme.accent.primary : cliTheme.text.muted}
                  attributes={TextAttributes.BOLD}
                >
                  {isSelected ? activeGlyphs.roleUser : " "}
                </text>
                <text
                  fg={
                    isSelected
                      ? cliTheme.overlay.selectedRowText
                      : cliTheme.text.primary
                  }
                  attributes={isSelected ? TextAttributes.BOLD : TextAttributes.NONE}
                >
                  {model.id}
                </text>
                <text fg={cliTheme.text.muted} marginLeft={2}>
                  {`${formatContextLength(model.contextLength)}${
                    model.supportsTools ? " · tools" : ""
                  }${model.supportsReasoning ? " · reasoning" : ""}`}
                </text>
                {model.id === currentModel && (
                  <text fg={cliTheme.accent.primary} marginLeft={2}>
                    (current)
                  </text>
                )}
              </box>
            );
          })}
          <box paddingX={2} marginTop={1}>
            <text fg={cliTheme.overlay.footerText}>
              {`${filteredModels.length} model${
                filteredModels.length === 1 ? "" : "s"
              }${isApplying ? " · switching..." : ""}`}
            </text>
          </box>
        </box>
      )}
    </box>
  );
}
