import { TextAttributes, typeRole } from "../ui/cli-theme";
import { borderStyleFor, cliTheme } from "../ui/cli-theme";

/** Minimal shape the menu needs; satisfied by routes and chat actions. */
export interface SlashMenuDisplayItem {
  id: string;
  label: string;
  description: string;
  shortcut: string;
}

interface SlashPageMenuProps {
  query: string;
  selectedIndex: number;
  routes: SlashMenuDisplayItem[];
}

export function SlashPageMenu({
  query,
  selectedIndex,
  routes,
}: SlashPageMenuProps) {
  const normalizedQuery = query.trim();
  const isFiltering = normalizedQuery.length > 0;

  return (
    <box
      width="100%"
      flexDirection="column"
      backgroundColor={cliTheme.overlay.surface}
      borderStyle={borderStyleFor.modal}
      borderColor={cliTheme.overlay.border}
    >
      {/* Menu Items Section */}
      <box flexDirection="column" paddingY={0}>
        {routes.length === 0 ? (
          <EmptyState query={normalizedQuery} />
        ) : (
          routes.map((route, index) => (
            <MenuItem
              key={route.id}
              route={route}
              selected={index === selectedIndex}
            />
          ))
        )}
      </box>

      <box
        flexDirection="row"
        alignItems="center"
        paddingX={2}
        paddingY={1}
        borderStyle="single"
        border={["top"]}
        borderColor={cliTheme.overlay.border}
      >
        <text fg={cliTheme.overlay.footerText}>
          {isFiltering
            ? `Showing: "${normalizedQuery.replace(/^\//, "")}" - ${routes.length} result${routes.length !== 1 ? "s" : ""}`
            : `${routes.length} page${routes.length !== 1 ? "s" : ""}`}
        </text>
        <box flexGrow={1} />
        <text {...typeRole("caption")}>Enter open | </text>
        <text {...typeRole("emphasis")}>Up/Down</text>
        <text {...typeRole("caption")}> select | Esc close</text>
      </box>
    </box>
  );
}

// Individual menu item component
interface MenuItemProps {
  route: SlashMenuDisplayItem;
  selected: boolean;
}

function MenuItem({ route, selected }: MenuItemProps) {
  const shortcutWithoutSlash = route.shortcut.replace(/^\//, "");

  return (
    <box
      flexDirection="row"
      alignItems="center"
      paddingX={2}
      paddingY={0}
      height={1}
      backgroundColor={
        selected ? cliTheme.overlay.selectedRowBackground : undefined
      }
    >
      {/* Selection Indicator */}
      <text
        width={2}
        fg={
          selected
            ? cliTheme.overlay.selectedBorder
            : cliTheme.text.muted
        }
      >
        {selected ? ">" : " "}
      </text>

      {/* Shortcut Badge */}
      <box
        backgroundColor={cliTheme.overlay.badgeBackground}
        paddingX={1}
        paddingY={0}
        marginRight={1}
      >
        <text
          fg={cliTheme.overlay.badgeText}
        >
          /{shortcutWithoutSlash}
        </text>
      </box>

      {/* Route Label */}
      <text
        fg={
          selected
            ? cliTheme.overlay.selectedRowText
            : cliTheme.text.primary
        }
        attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
        marginRight={2}
      >
        {route.label}
      </text>

      {/* Description - right aligned, fills remaining space */}
      <text
        fg={
          selected
            ? cliTheme.overlay.selectedRowText
            : cliTheme.overlay.description
        }
      >
        {route.description}
      </text>
    </box>
  );
}

// Empty state component
interface EmptyStateProps {
  query: string;
}

function EmptyState({ query }: EmptyStateProps) {
  const suggestions = ["/status", "/sessions", "/config", "/tools"];

  return (
    <box
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      paddingY={2}
      paddingX={2}
    >
      <text fg={cliTheme.overlay.footerText}>
        {`No matches for "${query.replace(/^\//, "")}"`}
      </text>
      <box flexDirection="row" gap={1} marginTop={1}>
        <text fg={cliTheme.overlay.footerText}>Try:</text>
        {suggestions.map((suggestion) => (
          <text
            key={suggestion}
            fg={cliTheme.accent.primary}
          >
            {suggestion}
          </text>
        ))}
      </box>
    </box>
  );
}
