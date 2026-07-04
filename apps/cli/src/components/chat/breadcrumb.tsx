import { cliTheme } from "../../ui/cli-theme";
import { activeGlyphs } from "../../ui/cli-theme-capabilities";

/**
 * VS Code-style inline breadcrumb: src › graph › file.ts. Renders as a single
 * text run (last segment emphasized) so it can sit inside any header row.
 */
export function Breadcrumb({ path }: { path: string }) {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return (
    <text wrapMode="none" truncate>
      {segments.map((segment, index) => (
        <span
          key={`${segment}-${index}`}
          fg={index === segments.length - 1 ? cliTheme.text.primary : cliTheme.text.muted}
        >
          {index > 0 ? ` ${activeGlyphs.breadcrumb} ${segment}` : segment}
        </span>
      ))}
    </text>
  );
}
