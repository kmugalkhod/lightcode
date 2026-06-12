import { lightcodeProviderSchema } from "@lightcode/ai";
import { getErrorMessage } from "@lightcode/shared";
import { Hono } from "hono";
import { z } from "zod";
import {
  getOpenRouterModelCapabilities,
  listOpenRouterModels,
} from "../lib/openrouter-models";
import { applyModelSelection, configStatus } from "../lib/runtime-config";

const selectModelRequestSchema = z.object({
  provider: lightcodeProviderSchema,
  model: z.string().min(1).max(240),
});

export const configRoutes = new Hono()
  .get("/status", (c) => c.json(configStatus))
  .get("/models", async (c) => {
    const provider = c.req.query("provider") ?? "openrouter";
    if (provider !== "openrouter") {
      return c.json(
        { error: `Model listing is not supported for provider "${provider}".` },
        400,
      );
    }

    try {
      const { models, fromCache } = await listOpenRouterModels({
        forceRefresh: c.req.query("refresh") === "1",
      });

      return c.json({
        generatedAt: new Date().toISOString(),
        provider,
        fromCache,
        models,
      });
    } catch (error) {
      return c.json(
        {
          error: `Unable to load OpenRouter models: ${getErrorMessage(error)}`,
        },
        502,
      );
    }
  })
  .put("/model", async (c) => {
    const parsed = selectModelRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid model selection payload." }, 400);
    }

    const { provider, model } = parsed.data;

    try {
      const capabilities =
        provider === "openrouter"
          ? await getOpenRouterModelCapabilities(model)
          : undefined;

      const status = applyModelSelection({ provider, model, capabilities });

      return c.json({
        ok: true,
        configStatus: status,
        capabilities: capabilities ?? null,
      });
    } catch (error) {
      return c.json(
        { error: `Unable to switch model: ${getErrorMessage(error)}` },
        400,
      );
    }
  });
