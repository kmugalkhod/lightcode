import { TextAttributes, typeRole } from "../ui/cli-theme";
import { useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../lib/client";
import { cliTheme } from "../ui/cli-theme";
import { lightcodeConfigStatusSchema, type LightcodeConfigStatus } from "@lightcode/ai";
import { getErrorMessage } from "../utils/text-utils";

export function ModelScreen() {
  const [isLoading, setIsLoading] = useState(true);
  const [payload, setPayload] = useState<LightcodeConfigStatus | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadModelConfig = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await client.config.status.$get();
      if (!response.ok) {
        throw new Error(`Unable to load model configuration (HTTP ${response.status}).`);
      }

      const rawPayload = await response.json();
      setPayload(lightcodeConfigStatusSchema.parse(rawPayload));
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, "Failed to load model configuration."));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModelConfig();
  }, [loadModelConfig]);

  useKeyboard((keyEvent) => {
    if (keyEvent.name.toLowerCase() !== "r") {
      return;
    }

    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    void loadModelConfig();
  });

  return (
    <box width="100%" height="100%" flexDirection="column" gap={1} paddingX={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text {...typeRole("title")}>Model</text>
        <text fg={cliTheme.text.muted}>
          {isLoading ? "loading..." : "press r to refresh"}
        </text>
      </box>

      {errorMessage ? (
        <box>
          <text fg={cliTheme.semantic.error}>{errorMessage}</text>
        </box>
      ) : payload ? (
        <scrollbox flexGrow={1} flexDirection="column" gap={1}>
          <ModelInfo payload={payload} />
          {payload.missingCredentialHints.length > 0 ? (
            <CredentialHints hints={payload.missingCredentialHints} />
          ) : null}
        </scrollbox>
      ) : null}
    </box>
  );
}

function ModelInfo({ payload }: { payload: LightcodeConfigStatus }) {
  const baseUrlStatus = payload.baseUrl ? "configured" : "default";

  return (
    <box
      flexDirection="column"
      gap={2}
      paddingY={1}
      borderStyle="single"
      borderColor={cliTheme.borders.subtle}
      backgroundColor={cliTheme.surfaces.panel}
    >
      <InfoRow label="Provider" value={payload.selectedProvider ?? "not set"} />
      <InfoRow label="Model" value={payload.selectedModel ?? "not set"} />
      <InfoRow
        label="Base URL"
        value={`${baseUrlStatus}${payload.baseUrl ? ` (${payload.baseUrl})` : ""}`}
      />
      <InfoRow label="Configured model" value={payload.configuredModel ?? "not set"} />
    </box>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <box flexDirection="row" gap={2}>
      <text fg={cliTheme.text.muted} width={18}>
        {label}
      </text>
      <text fg={cliTheme.text.primary}>{value}</text>
    </box>
  );
}

function CredentialHints({ hints }: { hints: string[] }) {
  return (
    <box
      flexDirection="column"
      gap={1}
      paddingY={1}
      borderStyle="single"
      borderColor={cliTheme.borders.subtle}
      backgroundColor={cliTheme.surfaces.panel}
    >
      <text fg={cliTheme.semantic.warning} attributes={TextAttributes.BOLD}>
        Missing Credentials
      </text>
      {hints.map((hint, index) => (
        <text key={index} fg={cliTheme.text.secondary}>
          - {hint}
        </text>
      ))}
    </box>
  );
}
