import type { ReactNode } from "react";
import { Icon } from "./icons";

/** Slim header above the conversation: title on the left, context on the right. */
export function TopBar({
  title,
  onOpenMenu,
  children,
}: {
  title?: string;
  onOpenMenu: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="top-bar">
      <button className="icon-button mobile-only" type="button" onClick={onOpenMenu} aria-label="Open sessions">
        <Icon name="menu" size={18} />
      </button>
      {title ? <h1 className="top-bar-title" title={title}>{title}</h1> : <span className="top-bar-title" />}
      <div className="top-bar-actions">{children}</div>
    </header>
  );
}
