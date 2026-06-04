/**
 * Minimal Express stub of /tasks. The demo task adds priority handling to the
 * POST validation and the response shape.
 */
import express from "express";
import type { Task } from "./types.js";
import { newTask } from "./types.js";

const app = express();
app.use(express.json());

const tasks = new Map<string, Task>();

app.get("/tasks", (_req, res) => {
  res.json([...tasks.values()]);
});

app.post("/tasks", (req, res) => {
  const { title, description } = req.body as { title?: string; description?: string };
  if (typeof title !== "string" || title.length === 0) {
    res.status(400).json({ error: "title required" });
    return;
  }
  // TODO(demo): validate an optional `priority` (low | medium | high) before creating.
  const t = newTask({ title, description });
  tasks.set(t.id, t);
  res.status(201).json(t);
});

app.delete("/tasks/:id", (req, res) => {
  const ok = tasks.delete(req.params["id"]!);
  res.status(ok ? 204 : 404).end();
});

const port = Number(process.env["PORT"] ?? 3001);
app.listen(port, () => {
  console.log(`todo-api listening on http://localhost:${port}`);
});
