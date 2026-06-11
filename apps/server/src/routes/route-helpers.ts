import { createLogger, getErrorMessage } from "@lightcode/shared";
import type { Context } from "hono";

const logger = createLogger("routes");

/**
 * Standard 500 response: logs the failure as a structured event and hides
 * error details from clients in production.
 */
export function internalErrorResponse(
  c: Context,
  {
    event,
    message,
    error,
  }: {
    event: string;
    message: string;
    error: unknown;
  },
) {
  logger.error(event, { error: getErrorMessage(error) });

  return c.json(
    {
      error: message,
      details:
        Bun.env.NODE_ENV === "production" ? undefined : getErrorMessage(error),
    },
    500,
  );
}
