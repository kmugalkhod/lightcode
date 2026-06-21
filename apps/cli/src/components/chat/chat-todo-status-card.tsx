import { TextAttributes } from "@opentui/core";
import type { TodoItem } from "@lightcode/ai";
import { borderStyleFor, cliTheme } from "../../ui/cli-theme";
import { truncateInline } from "../../utils/text-utils";

interface ChatTodoStatusCardProps {
  todos: TodoItem[];
}

const todoStatusLabel = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  canceled: "Canceled",
} satisfies Record<TodoItem["status"], string>;

function getStatusColor(status: TodoItem["status"]) {
  if (status === "completed") {
    return cliTheme.semantic.success;
  }

  if (status === "in_progress") {
    return cliTheme.semantic.info;
  }

  if (status === "canceled") {
    return cliTheme.text.muted;
  }

  return cliTheme.text.secondary;
}

export function ChatTodoStatusCard({ todos }: ChatTodoStatusCardProps) {
  if (todos.length === 0) {
    return null;
  }

  const completedCount = todos.filter((todo) => todo.status === "completed").length;
  const percent = todos.length > 0 ? Math.round((completedCount / todos.length) * 100) : 0;
  const progressText = completedCount === 0 
    ? "Not started" 
    : `${completedCount}/${todos.length} done (${percent}%)`;

  return (
    <box
      width="100%"
      flexDirection="column"
      borderStyle={borderStyleFor.card}
      borderColor={cliTheme.semantic.info}
      backgroundColor={cliTheme.surfaces.panel}
      paddingX={1}
      paddingY={1}
      gap={1}
    >
      <box width="100%" flexDirection="row" justifyContent="space-between">
        <text fg={cliTheme.semantic.info} attributes={TextAttributes.BOLD}>
          Session Todo
        </text>
        <text fg={cliTheme.text.muted}>
          {progressText}
        </text>
      </box>

      <box width="100%" flexDirection="column">
        {todos.map((todo, index) => {
          // For the active item, show its present-tense activeForm (e.g.
          // "Adding tests") when the model set one, falling back to content.
          const isActive = todo.status === "in_progress";
          const label = isActive && todo.activeForm
            ? todo.activeForm
            : todo.content;

          return (
            <box key={todo.id ?? `${todo.content}-${index}`} width="100%" flexDirection="row" gap={1}>
              <text fg={getStatusColor(todo.status)}>
                {todo.status === "completed" ? "[x]" : "[ ]"}
              </text>
              <text fg={cliTheme.text.primary}>
                {truncateInline(label)}
              </text>
              {isActive && todo.activeForm ? (
                <text fg={cliTheme.text.muted} attributes={TextAttributes.DIM}>
                  {truncateInline(todo.content)}
                </text>
              ) : null}
              <text fg={getStatusColor(todo.status)} attributes={TextAttributes.DIM}>
                {todoStatusLabel[todo.status]}
              </text>
            </box>
          );
        })}
      </box>

    </box>
  );
}
