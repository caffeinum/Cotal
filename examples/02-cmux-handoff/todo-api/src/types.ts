/**
 * Task model — the canonical shape the API, web, and docs all reference.
 * This is the file the demo's "add priority" task primarily touches.
 */

export type TaskId = string;

export interface Task {
  id: TaskId;
  title: string;
  description?: string;
  completed: boolean;
  // TODO(demo): add a `priority` field (low | medium | high, default medium).
  createdAt: string; // ISO timestamp
}

export function newTask(input: { title: string; description?: string }): Task {
  return {
    id: crypto.randomUUID(),
    title: input.title,
    description: input.description,
    completed: false,
    // TODO(demo): default the new priority field here.
    createdAt: new Date().toISOString(),
  };
}
