import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandComposer } from "./command-composer";

function render(streaming = false, toolbarEnd?: React.ReactNode) {
  return renderToStaticMarkup(<CommandComposer appearance="conversation" hasSession canSendMessage={!streaming}
    placeholder="Message" commandResult={null} commandBusy={null} onDismissResult={() => {}}
    onSubmit={() => {}} onCommand={() => {}} onUnknownCommand={() => {}}
    isStreaming={streaming} onAbort={() => {}} toolbarEnd={toolbarEnd} />);
}

test("the toolbar stays quiet: a commands button and a send button, no session banner", () => {
  const html = render();
  expect(html).toContain('aria-label="Commands"');
  expect(html).toContain('aria-label="Send message"');
  expect(html).not.toContain("composer-session");
});

test("a run swaps send for Stop run and marks the shell as streaming", () => {
  const html = render(true);
  expect(html).toContain('aria-label="Stop run"');
  expect(html).not.toContain('aria-label="Send message"');
  expect(html).toContain("is-streaming");
});

test("toolbar status renders before the send button", () => {
  const html = render(false, <span className="probe">ctx</span>);
  expect(html.indexOf("probe")).toBeLessThan(html.indexOf('aria-label="Send message"'));
});
