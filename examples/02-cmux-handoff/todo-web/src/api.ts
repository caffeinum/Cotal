/**
 * MOCK api — returns canned data so the UI runs without a backend.
 *
 * In the API→web handoff, the orchestrator will tell you to remove this mock
 * and connect to the real todo-api `/tasks` endpoint.
 */

export interface Task {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  createdAt: string;
  // TODO(demo): the priority field arrives with the API; surface it in the UI.
}

const MOCK: Task[] = [
  { id: "1", title: "Write the demo", completed: true, createdAt: "2026-05-29T09:00:00Z" },
  { id: "2", title: "Ship task priority", completed: false, createdAt: "2026-05-29T10:00:00Z" },
];

export async function listTasks(): Promise<Task[]> {
  return Promise.resolve(MOCK);
}

export async function createTask(input: { title: string; description?: string }): Promise<Task> {
  const t: Task = {
    id: crypto.randomUUID(),
    title: input.title,
    description: input.description,
    completed: false,
    createdAt: new Date().toISOString(),
  };
  MOCK.push(t);
  return Promise.resolve(t);
}
