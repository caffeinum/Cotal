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
<!-- TODO(demo): add a `priority` row (one of low, medium, high; defaults to medium). -->

## Endpoints

### `GET /tasks`

Returns an array of every task.

### `POST /tasks`

Create a new task.

**Request body:**

```json
{
  "title": "Ship the priority feature",
  "description": "End to end across api, web, docs"
}
```

<!-- TODO(demo): document the optional `priority` field in the request body. -->

**Response:** `201 Created` with the new Task object.

### `DELETE /tasks/:id`

Delete a task by id. Returns `204 No Content` on success, `404` if no such id exists.
