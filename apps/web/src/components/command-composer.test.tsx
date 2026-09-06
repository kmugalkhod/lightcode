import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandComposer, type ComposerSessionInfo } from "./command-composer";

const info: ComposerSessionInfo = { title: "Explain the project", mode: "Plan mode", permission: "Read only", messageCount: 1, status: "Ready" };
function render(sessionInfo?: ComposerSessionInfo, streaming = false) {
  return renderToStaticMarkup(<CommandComposer appearance="conversation" hasSession canSendMessage={!streaming}
    placeholder="Message" commandResult={null} commandBusy={null} onDismissResult={() => {}}
    onSubmit={() => {}} onCommand={() => {}} onUnknownCommand={() => {}}
    sessionInfo={sessionInfo} isStreaming={streaming} onAbort={() => {}} />);
}

test("session details occupy a collapsed toolbar control, not a persistent banner", () => {
  const html = render(info);
  expect(html).toContain('aria-label="Session details: Explain the project"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('role="status">Ready');
  expect(html).not.toContain('class="composer-session-panel"');
  expect(html).not.toContain("conversation-heading");
});

test("session control is optional and doesn't affect the starter composer", () => {
  expect(render()).not.toContain("composer-session-context");
  expect(render()).toContain("Commands");
});

test("important status remains visible alongside Stop run", () => {
  const html = render({ ...info, status: "Input needed" }, true);
  expect(html).toContain('role="status">Input needed');
  expect(html).toContain("Stop run");
  expect(html).toContain("Session details");
});
