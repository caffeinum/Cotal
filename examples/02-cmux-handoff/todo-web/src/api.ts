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
    body: JSON.stringify({
      title: input.title,
      description: input.description,
      priority: input.priority ?? "medium",
    }),
  });
  if (res.status === 400) {
    const detail = (await res.text()).trim();
    throw new Error(`createTask: invalid priority${detail ? ` — ${detail}` : ""}`);
  }
  if (!res.ok) throw new Error(`createTask failed: ${res.status}`);
  return res.json();
}
