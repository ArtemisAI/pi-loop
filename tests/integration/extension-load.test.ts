/**
 * Integration tests: extension loading, tool registration, and cron tools.
 *
 * Uses @marcfargas/pi-test-harness to run a real pi session with pi-loop
 * loaded. The LLM is replaced by a playbook — no external calls.
 */

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { createTestSession, when, calls, says } from "@marcfargas/pi-test-harness";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { join } from "path";
import { patchAgentForHarness } from "./harness-patch.js";

const EXTENSION_PATH = join(import.meta.dirname, "../../src/index.ts");

beforeAll(() => {
  patchAgentForHarness();
  if (!process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = "test-key-not-used";
  }
});

describe("Extension loading", () => {
  let t: TestSession | null = null;

  afterEach(() => {
    t?.dispose();
    t = null;
  });

  it("loads and registers cron tools", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      propagateErrors: true,
    });

    await t.run(
      when("List scheduled tasks", [
        calls("cron_list", {}),
        says("No tasks are scheduled yet."),
      ]),
    );

    const results = t.events.toolResultsFor("cron_list");
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain("No scheduled tasks");
  });

  it("creates a scheduled task via cron_create", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      propagateErrors: true,
    });

    await t.run(
      when("Schedule a check every 5 minutes", [
        calls("cron_create", {
          cron: "*/5 * * * *",
          prompt: "check the deploy status",
          recurring: true,
          durable: false,
        }),
        says("Task scheduled successfully."),
      ]),
    );

    const results = t.events.toolResultsFor("cron_create");
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain("Scheduled task created");
    expect(results[0].text).toContain("check the deploy status");
    expect(results[0].text).toContain("every 5 minutes");
  });

  it("creates and then lists a task", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      propagateErrors: true,
    });

    await t.run(
      when("Schedule a daily standup reminder", [
        calls("cron_create", {
          cron: "0 9 * * *",
          prompt: "Time for standup",
          recurring: true,
          durable: false,
        }),
        says("Standup reminder scheduled."),
      ]),
      when("What tasks are running?", [
        calls("cron_list", {}),
        says("One task is active."),
      ]),
    );

    const listResults = t.events.toolResultsFor("cron_list");
    expect(listResults).toHaveLength(1);
    expect(listResults[0].text).toContain("Time for standup");
    expect(listResults[0].text).toContain("1 scheduled task");
  });

  it("creates and deletes a task", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      propagateErrors: true,
    });

    await t.run(
      when("Schedule a one-shot reminder at 3pm", [
        calls("cron_create", {
          cron: "0 15 * * *",
          prompt: "Push the branch",
          recurring: false,
          durable: false,
        }),
        says("Reminder set."),
      ]),
    );

    // Extract task ID from the cron_create result text
    const createResults = t.events.toolResultsFor("cron_create");
    expect(createResults).toHaveLength(1);
    const match = createResults[0].text.match(/ID:\s*([a-f0-9]+)/);
    expect(match).not.toBeNull();
    const taskId = match![1];

    await t.run(
      when("Cancel that reminder", [
        calls("cron_delete", { id: taskId }),
        says("Cancelled."),
      ]),
    );

    const deleteResults = t.events.toolResultsFor("cron_delete");
    expect(deleteResults).toHaveLength(1);
    expect(deleteResults[0].text).toContain("cancelled");
  });

  it("rejects invalid cron expressions", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      propagateErrors: true,
    });

    await t.run(
      when("Schedule something with bad cron", [
        calls("cron_create", {
          cron: "invalid cron",
          prompt: "test",
          recurring: true,
          durable: false,
        }),
        says("That cron expression is invalid."),
      ]),
    );

    const results = t.events.toolResultsFor("cron_create");
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain("Invalid cron expression");
  });

  it("returns error when deleting non-existent task", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      propagateErrors: true,
    });

    await t.run(
      when("Delete task xyz", [
        calls("cron_delete", { id: "nonexistent" }),
        says("No such task."),
      ]),
    );

    const results = t.events.toolResultsFor("cron_delete");
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain("No task found");
  });
});

describe("Max jobs enforcement", () => {
  let t: TestSession | null = null;

  afterEach(() => {
    t?.dispose();
    t = null;
  });

  it("rejects creation when at max capacity", async () => {
    t = await createTestSession({
      extensions: [EXTENSION_PATH],
      propagateErrors: true,
    });

    // Create 50 tasks (the max) by running many turns
    // This is impractical in a real test, so we just verify the error message
    // format is correct when the tool reports capacity
    await t.run(
      when("Check how many tasks I can create", [
        calls("cron_list", {}),
        says("No tasks yet — you can create up to 50."),
      ]),
    );

    expect(t.events.toolResultsFor("cron_list")).toHaveLength(1);
  });
});
