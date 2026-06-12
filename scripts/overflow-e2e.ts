/**
 * E2E check for progressive context-overflow recovery against the mock
 * provider (model mock-overflow rejects request bodies > 8 KB). Simulates
 * the client retry loop: re-POSTs the same history until the server's
 * forced compaction shrinks the provider view below the mock's limit.
 */
const base = process.env.LIGHTCODE_URL ?? "http://127.0.0.1:3987";

const sessionResponse = await fetch(`${base}/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "overflow-e2e" }),
});
const { id: sessionId } = (await sessionResponse.json()) as { id: string };

await fetch(`${base}/config/model`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "openai-compatible", model: "mock-overflow" }),
});

const filler = (label: string) =>
  `${label}: ${"The build pipeline reads configuration from disk and validates every module before bundling. ".repeat(20)}`;

const messages: Array<Record<string, unknown>> = [];
for (let index = 0; index < 6; index += 1) {
  messages.push({
    id: `u${index}`,
    role: "user",
    parts: [{ type: "text", text: filler(`user turn ${index}`) }],
  });
  messages.push({
    id: `a${index}`,
    role: "assistant",
    parts: [{ type: "text", text: filler(`assistant turn ${index}`) }],
  });
}
messages.push({
  id: "u-final",
  role: "user",
  parts: [{ type: "text", text: "Summarize the project status briefly." }],
});

for (let attempt = 1; attempt <= 6; attempt += 1) {
  const response = await fetch(`${base}/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages, cwd: process.cwd(), mode: "build" }),
  });

  const body = await response.text();
  const errorLine = body
    .split("\n")
    .find((line) => line.includes('"type":"error"'));

  if (!errorLine) {
    const gotText = body.includes("text-delta");
    console.log(
      `attempt ${attempt}: SUCCESS (streamed completion: ${gotText})`,
    );
    process.exit(gotText ? 0 : 1);
  }

  const kindMatch = errorLine.match(/\\"kind\\":\\"([a-z_]+)\\"/);
  console.log(`attempt ${attempt}: error kind=${kindMatch?.[1] ?? "unknown"}`);

  if (kindMatch?.[1] !== "context_overflow") {
    console.error("Unexpected error kind — aborting.");
    console.error(errorLine.slice(0, 400));
    process.exit(1);
  }
}

console.error("Recovery did not converge within 6 attempts.");
process.exit(1);
