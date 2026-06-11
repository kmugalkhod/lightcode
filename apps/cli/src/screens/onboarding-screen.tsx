import { writeStoredCredentials, type StoredCredentials } from "@lightcode/ai";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { ChatTextArea } from "../components/chat/chat-text-area";
import { restartOwnedServer } from "../lib/server-launcher";
import { useAppState } from "../state/app-state";
import { cliTheme } from "../ui/cli-theme";
import { getErrorMessage } from "../utils/text-utils";
import { isDownKey, isEnterKey, isUpKey } from "../utils/key-utils";

interface ProviderChoice {
  id: "anthropic" | "openrouter" | "opencode-zen" | "openai-compatible";
  label: string;
  description: string;
  credentialKey: keyof StoredCredentials;
  needsModel: boolean;
  needsBaseUrl: boolean;
  keyHint: string;
}

const providerChoices: ProviderChoice[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude models - recommended default",
    credentialKey: "anthropicApiKey",
    needsModel: false,
    needsBaseUrl: false,
    keyHint: "Console: console.anthropic.com/settings/keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "Hundreds of models via openrouter.ai",
    credentialKey: "openrouterApiKey",
    needsModel: true,
    needsBaseUrl: false,
    keyHint: "Console: openrouter.ai/keys",
  },
  {
    id: "opencode-zen",
    label: "OpenCode Zen",
    description: "OpenCode hosted models",
    credentialKey: "opencodeApiKey",
    needsModel: true,
    needsBaseUrl: false,
    keyHint: "Console: opencode.ai",
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    description: "Any OpenAI-style endpoint (needs base URL)",
    credentialKey: "openaiCompatibleApiKey",
    needsModel: true,
    needsBaseUrl: true,
    keyHint: "Use the key for your endpoint (leave model/base URL accurate)",
  },
];

type OnboardingStep = "provider" | "apiKey" | "model" | "baseUrl" | "saving" | "done";

function getUserSettingsPath(): string {
  const configured = process.env.LIGHTCODE_USER_CONFIG?.trim();
  return configured ?? path.join(os.homedir(), ".lightcode", "settings.json");
}

function mergeUserSettings(update: Record<string, unknown>): string {
  const settingsPath = getUserSettingsPath();
  let existing: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Unreadable settings are preserved nowhere; the merged write wins.
    }
  }

  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ ...existing, ...update }, null, 2)}\n`,
    "utf8",
  );
  return settingsPath;
}

export function OnboardingScreen() {
  const navigate = useNavigate();
  const { bumpConfigRefresh } = useAppState();
  const [step, setStep] = useState<OnboardingStep>("provider");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [serverRestarted, setServerRestarted] = useState(false);

  const provider = providerChoices[selectedIndex];

  const completeSetup = useCallback(
    async ({
      finalModel,
      finalBaseUrl,
      key,
    }: {
      finalModel: string;
      finalBaseUrl: string;
      key: string;
    }) => {
      setStep("saving");
      setErrorText(null);

      try {
        writeStoredCredentials({ [provider.credentialKey]: key });
        mergeUserSettings({
          provider: provider.id,
          ...(finalModel ? { model: finalModel } : {}),
          ...(finalBaseUrl ? { baseUrl: finalBaseUrl } : {}),
        });

        const restarted = await restartOwnedServer();
        setServerRestarted(restarted);
        bumpConfigRefresh();
        setStep("done");
      } catch (error) {
        setErrorText(getErrorMessage(error, "Unable to save configuration."));
        setStep("apiKey");
      }
    },
    [bumpConfigRefresh, provider],
  );

  useKeyboard((keyEvent) => {
    if (step === "provider") {
      if (isDownKey(keyEvent.name)) {
        keyEvent.preventDefault();
        setSelectedIndex((index) => Math.min(index + 1, providerChoices.length - 1));
      } else if (isUpKey(keyEvent.name)) {
        keyEvent.preventDefault();
        setSelectedIndex((index) => Math.max(index - 1, 0));
      } else if (isEnterKey(keyEvent.name)) {
        keyEvent.preventDefault();
        setStep("apiKey");
      }
      return;
    }

    if (step === "done" && isEnterKey(keyEvent.name)) {
      keyEvent.preventDefault();
      navigate("/");
    }
  });

  return (
    <box width="100%" height="100%" flexDirection="column" alignItems="center" paddingTop={2}>
      <box width={72} flexDirection="column" gap={1}>
        <text fg={cliTheme.accent.primary} attributes={TextAttributes.BOLD}>
          Welcome to Lightcode
        </text>
        <text fg={cliTheme.text.secondary}>
          One-time setup: pick a model provider and store an API key.
        </text>
        <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
          Keys are stored in ~/.lightcode/credentials.json (environment
          variables always take precedence).
        </text>

        {errorText ? (
          <text fg={cliTheme.semantic.error}>{errorText}</text>
        ) : null}

        {step === "provider" ? (
          <box
            flexDirection="column"
            borderStyle="single"
            borderColor={cliTheme.borders.default}
            backgroundColor={cliTheme.surfaces.panel}
            paddingX={1}
            paddingY={1}
          >
            <text fg={cliTheme.text.primary} attributes={TextAttributes.BOLD}>
              Choose a provider
            </text>
            {providerChoices.map((choice, index) => (
              <box
                key={choice.id}
                flexDirection="row"
                gap={1}
                backgroundColor={
                  index === selectedIndex
                    ? cliTheme.overlay.selectedRowBackground
                    : undefined
                }
                paddingX={1}
              >
                <text
                  fg={
                    index === selectedIndex
                      ? cliTheme.accent.primary
                      : cliTheme.text.muted
                  }
                >
                  {index === selectedIndex ? ">" : " "}
                </text>
                <text
                  fg={
                    index === selectedIndex
                      ? cliTheme.overlay.selectedRowText
                      : cliTheme.text.primary
                  }
                  attributes={
                    index === selectedIndex ? TextAttributes.BOLD : TextAttributes.NONE
                  }
                >
                  {choice.label}
                </text>
                <text fg={cliTheme.overlay.description}>{choice.description}</text>
              </box>
            ))}
            <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
              Up/Down select - Enter continue
            </text>
          </box>
        ) : null}

        {step === "apiKey" ? (
          <box flexDirection="column" gap={1}>
            <text fg={cliTheme.text.primary}>
              {`Paste your ${provider.label} API key and press Enter`}
            </text>
            <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
              {provider.keyHint}
            </text>
            <ChatTextArea
              placeholder="API key..."
              onSubmit={(text) => {
                const trimmedKey = text.trim();
                if (!trimmedKey) {
                  return;
                }

                setApiKey(trimmedKey);
                if (provider.needsModel) {
                  setStep("model");
                } else {
                  void completeSetup({ finalModel: "", finalBaseUrl: "", key: trimmedKey });
                }
              }}
            />
          </box>
        ) : null}

        {step === "model" ? (
          <box flexDirection="column" gap={1}>
            <text fg={cliTheme.text.primary}>
              {`Model id for ${provider.label} (e.g. ${
                provider.id === "openrouter"
                  ? "anthropic/claude-sonnet-4-6"
                  : "your model id"
              })`}
            </text>
            <ChatTextArea
              placeholder="Model id..."
              onSubmit={(text) => {
                const trimmedModel = text.trim();
                if (!trimmedModel) {
                  return;
                }

                setModel(trimmedModel);
                if (provider.needsBaseUrl) {
                  setStep("baseUrl");
                } else {
                  void completeSetup({
                    finalModel: trimmedModel,
                    finalBaseUrl: "",
                    key: apiKey,
                  });
                }
              }}
            />
          </box>
        ) : null}

        {step === "baseUrl" ? (
          <box flexDirection="column" gap={1}>
            <text fg={cliTheme.text.primary}>
              Base URL of the OpenAI-compatible endpoint
            </text>
            <ChatTextArea
              placeholder="https://..."
              onSubmit={(text) => {
                const trimmedBaseUrl = text.trim();
                if (!trimmedBaseUrl) {
                  return;
                }

                void completeSetup({
                  finalModel: model,
                  finalBaseUrl: trimmedBaseUrl,
                  key: apiKey,
                });
              }}
            />
          </box>
        ) : null}

        {step === "saving" ? (
          <text fg={cliTheme.semantic.info}>Saving configuration and restarting the server...</text>
        ) : null}

        {step === "done" ? (
          <box flexDirection="column" gap={1}>
            <text fg={cliTheme.semantic.success} attributes={TextAttributes.BOLD}>
              Setup complete
            </text>
            <text fg={cliTheme.text.secondary}>
              {serverRestarted
                ? "The local server was restarted with your new configuration."
                : "Restart the Lightcode server to pick up the new configuration."}
            </text>
            <text fg={cliTheme.text.muted}>Press Enter to start coding.</text>
          </box>
        ) : null}
      </box>
    </box>
  );
}
