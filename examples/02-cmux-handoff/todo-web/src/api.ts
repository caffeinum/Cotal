/**
 * todo-api client — talks to the real `/tasks` endpoint.
 */

export type Priority = "low" | "medium" | "high";

export interface Task {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  priority: Priority;
  createdAt: string;
}

export async function listTasks(): Promise<Task[]> {
  const res = await fetch("/tasks");
  if (!res.ok) throw new Error(`listTasks failed: ${res.status}`);
  return res.json();
}

export async function createTask(input: {
  title: string;
  description?: string;
  priority?: Priority;
}): Promise<Task> {
  const res = await fetch("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // priority/description omitted when undefined — the server applies its own
    // default (priority "medium").
    body: JSON.stringify({
      title: input.title,
      description: input.description,
      priority: input.priority,
    }),
  });
  if (res.status === 400) {
    const { error } = await res.json();
    throw new Error(`createTask: ${error}`);
  }
  if (!res.ok) throw new Error(`createTask failed: ${res.status}`);
  return res.json();
}
