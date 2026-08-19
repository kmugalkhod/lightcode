import type { SVGProps } from "react";

export type IconName =
  | "abort"
  | "agent"
  | "arrow-up"
  | "back"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "code"
  | "folder"
  | "folder-open"
  | "history"
  | "instructions"
  | "lightcode"
  | "menu"
  | "message"
  | "mcp"
  | "more"
  | "plus"
  | "search"
  | "settings"
  | "shield"
  | "spark"
  | "terminal"
  | "tool"
  | "warning"
  | "x";

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  name: IconName;
  size?: number;
}

function IconPaths({ name }: { name: IconName }) {
  switch (name) {
    case "abort":
      return <rect x="7" y="7" width="10" height="10" rx="1.5" />;
    case "agent":
      return (
        <>
          <rect x="5" y="7" width="14" height="11" rx="3" />
          <path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
        </>
      );
    case "arrow-up":
      return <path d="m7 11 5-5 5 5M12 6v12" />;
    case "back":
      return <path d="m15 18-6-6 6-6" />;
    case "check":
      return <path d="m5 12 4 4L19 6" />;
    case "chevron-down":
      return <path d="m7 10 5 5 5-5" />;
    case "chevron-right":
      return <path d="m10 7 5 5-5 5" />;
    case "code":
      return <path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14" />;
    case "folder":
      return <path d="M3.5 7.5h6l2-2h3l2 2h4v11h-17z" />;
    case "folder-open":
      return <path d="M3.5 8V6h6l2 2h8l-2 10h-14l2-8h15" />;
    case "history":
      return (
        <>
          <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" />
          <path d="M4 4v4.5h4.5M12 8v4l3 2" />
        </>
      );
    case "instructions":
      return (
        <>
          <path d="M5 4.5h14v15H5zM8 8h8M8 12h8M8 16h5" />
        </>
      );
    case "lightcode":
      return (
        <>
          <path d="M12.5 2.8 5 13h6l-.5 8.2L19 10h-6z" />
        </>
      );
    case "menu":
      return <path d="M4 7h16M4 12h16M4 17h16" />;
    case "message":
      return <path d="M4 5.5h16v11H9l-5 3z" />;
    case "mcp":
      return (
        <>
          <rect x="4" y="4" width="6" height="6" rx="1" />
          <rect x="14" y="14" width="6" height="6" rx="1" />
          <path d="M10 7h4a3 3 0 0 1 3 3v4M14 17h-4a3 3 0 0 1-3-3v-4" />
        </>
      );
    case "more":
      return (
        <>
          <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
        </>
      );
    case "plus":
      return <path d="M12 5v14M5 12h14" />;
    case "search":
      return (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 4 4" />
        </>
      );
    case "settings":
      return (
        <>
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M7 14v6" />
        </>
      );
    case "shield":
      return <path d="M12 3 5 6v5c0 4.7 2.8 8 7 10 4.2-2 7-5.3 7-10V6zM9 12l2 2 4-4" />;
    case "spark":
      return <path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z" />;
    case "terminal":
      return <path d="M4 5h16v14H4zM7 9l3 3-3 3M12 15h5" />;
    case "tool":
      return <path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5L16 12l-4-4z" />;
    case "warning":
      return <path d="M12 4 3.5 19h17zM12 9v4M12 16h.01" />;
    case "x":
      return <path d="m6 6 12 12M18 6 6 18" />;
  }
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...props}
    >
      <IconPaths name={name} />
    </svg>
  );
}
