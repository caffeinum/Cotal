# API Reference

Base URL: `http://localhost:3001`

## The Task object

| Field         | Type     | Required | Description                          |
|---------------|----------|----------|--------------------------------------|
| `id`          | string   | yes      | Unique task identifier (UUID).       |
| `title`       | string   | yes      | One-line summary.                    |
| `description` | string   | no       | Longer free-text body.               |
| `completed`   | boolean  | yes      | Whether the task is done.            |
| `createdAt`   | ISO date | yes      | When the task was created.           |
| `priority`    | string   | no       | One of `low`, `medium`, `high`. Defaults to `medium`. |

## Endpoints

### `GET /tasks`

Returns an array of every task.

### `POST /tasks`

Create a new task.

**Request body:**

```json
{
  "title": "Ship the priority feature",
  "description": "End to end across api, web, docs",
  "priority": "high"
}
```

The `priority` field is optional and accepts `low`, `medium`, or `high`. When omitted it
defaults to `medium`.

**Response:** `201 Created` with the new Task object.

### `DELETE /tasks/:id`

Delete a task by id. Returns `204 No Content` on success, `404` if no such id exists.
