import { useEffect, useState } from "react";

const slowPickerHintDelayMs = 3_000;

export function PickerPendingBanner({
  isWindows,
  onCancel,
}: {
  isWindows: boolean;
  onCancel: () => void;
}) {
  const [showSlowHint, setShowSlowHint] = useState(false);

  useEffect(() => {
    if (!isWindows) return;
    const timer = window.setTimeout(
      () => setShowSlowHint(true),
      slowPickerHintDelayMs,
    );
    return () => window.clearTimeout(timer);
  }, [isWindows]);

  return (
    <div className="picker-pending-banner" role="status" aria-live="polite">
      <span className="inline-spinner" aria-hidden="true" />
      <span>
        <strong>Opening the system folder dialog…</strong>
        {showSlowHint ? (
          <small>
            First launch can take up to ~20 s. The dialog may open behind this
            window; check the taskbar for “Lightcode - choose a project folder”.
          </small>
        ) : null}
      </span>
      <button className="secondary-button" type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
