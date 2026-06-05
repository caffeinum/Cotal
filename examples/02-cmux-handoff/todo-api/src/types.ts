/**
 * Task model — the canonical shape the API, web, and docs all reference.
 * This is the file the demo's "add priority" task primarily touches.
 */

export type TaskId = string;

export type Priority = "low" | "medium" | "high";

export const PRIORITIES: readonly Priority[] = ["low", "medium", "high"];

export function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);
}

export interface Task {
  id: TaskId;
  title: string;
  description?: string;
  completed: boolean;
  priority: Priority;
  createdAt: string; // ISO timestamp
}

export function newTask(input: { title: string; description?: string; priority?: Priority }): Task {
  return {
    id: crypto.randomUUID(),
    title: input.title,
    description: input.description,
    completed: false,
    priority: input.priority ?? "medium",
    createdAt: new Date().toISOString(),
  };
}
