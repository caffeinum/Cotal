import { test } from "node:test";
import assert from "node:assert/strict";
import { newTask, isPriority } from "./types.js";

test("newTask defaults priority to medium", () => {
  const t = newTask({ title: "buy milk" });
  assert.equal(t.priority, "medium");
});

test("newTask keeps an explicit priority", () => {
  const t = newTask({ title: "ship demo", priority: "high" });
  assert.equal(t.priority, "high");
});

test("isPriority accepts the enum and rejects everything else", () => {
  assert.ok(isPriority("low"));
  assert.ok(isPriority("medium"));
  assert.ok(isPriority("high"));
  assert.equal(isPriority("urgent"), false);
  assert.equal(isPriority(""), false);
  assert.equal(isPriority(undefined), false);
});
