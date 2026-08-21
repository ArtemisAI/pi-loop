/**
 * /loops — interactive dashboard for viewing and managing loop/cron tasks.
 *
 * Renders every active loop (session + durable) with its human frequency and
 * next fire time, and supports inline editing of a loop's prompt or frequency
 * plus cancellation — all against the same in-memory store the scheduler reads,
 * so changes take effect immediately (no restart, no re-issuing /loop).
 *
 * The pure helpers (formatDuration, taskNextFireMs, parseFrequencyInput,
 * applyPromptEdit, applyFrequencyEdit) are deliberately separated from the TUI
 * component so the formatting and mutation logic is unit-testable without a
 * terminal.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import { cronToHuman, intervalToCron, nextCronRunMs, parseCronExpression } from "./cron.js";
import { clearAllTasks, getAllTasks, removeTask, updateTask, writeDurableTasks } from "./store.js";
import type { LoopConfig, LoopTask } from "./types.js";

// --- Pure helpers (unit-tested) ---

/** Human-friendly countdown for a positive duration in ms. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.ceil(totalSec / 60);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Next fire time (epoch ms) for a task: prefer the scheduler-maintained
 * `nextFireTime` when it is still in the future, otherwise recompute from cron.
 */
export function taskNextFireMs(task: LoopTask, nowMs: number): number | null {
  if (typeof task.nextFireTime === "number" && task.nextFireTime > nowMs) {
    return task.nextFireTime;
  }
  return nextCronRunMs(task.cron, task.lastFiredAt ?? task.createdAt);
}

export type FrequencyParse = { cron: string } | { error: string };

/** Accept either an interval shorthand (5m, 2h, 1d, 30s) or a raw 5-field cron. */
export function parseFrequencyInput(input: string): FrequencyParse {
  const value = input.trim();
  if (!value) return { error: "Frequency cannot be empty" };
  if (/^\d+[smhd]$/i.test(value)) {
    const cron = intervalToCron(value.toLowerCase());
    if (!cron) return { error: `Invalid interval: "${value}"` };
    return { cron };
  }
  if (parseCronExpression(value)) return { cron: value };
  return { error: `Use an interval (e.g. 5m) or 5-field cron (e.g. */5 * * * *)` };
}

export type EditResult = { ok: true; task: LoopTask } | { ok: false; error: string };

export function applyPromptEdit(task: LoopTask, newPrompt: string): EditResult {
  const prompt = newPrompt.trim();
  if (!prompt) return { ok: false, error: "Prompt cannot be empty" };
  return { ok: true, task: { ...task, prompt } };
}

export function applyFrequencyEdit(task: LoopTask, input: string): EditResult {
  const parsed = parseFrequencyInput(input);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  return { ok: true, task: { ...task, cron: parsed.cron } };
}

// --- Runtime context supplied by the extension closure ---

export interface LoopsUiDeps {
  getConfig(): LoopConfig;
  getCwd(): string;
  refreshStatus(): void;
  schedulerRunning(): boolean;
}

// --- Interactive component ---

type Mode = "list" | "edit" | "confirmOne" | "confirmAll";

/** True when every code point in `data` is a printable (non-control) character. */
function isPrintable(data: string): boolean {
  if (data.length === 0) return false;
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export class LoopsDashboard implements Component {
  private mode: Mode = "list";
  private cursor = 0;
  private editField: "prompt" | "frequency" = "prompt";
  private editBuffer = "";
  private editError?: string;
  private notice?: string;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly deps: LoopsUiDeps,
  ) {}

  invalidate(): void {}

  private tasks(): LoopTask[] {
    return getAllTasks()
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  private rerender(): void {
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.mode === "edit") return this.handleEditInput(data);
    if (this.mode === "confirmOne" || this.mode === "confirmAll") return this.handleConfirmInput(data);
    return this.handleListInput(data);
  }

  private handleListInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.done();
      return;
    }

    const tasks = this.tasks();
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.cursor = Math.max(0, this.cursor - 1);
      this.notice = undefined;
      this.rerender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.cursor = Math.min(Math.max(0, tasks.length - 1), this.cursor + 1);
      this.notice = undefined;
      this.rerender();
      return;
    }

    if (tasks.length === 0) return;
    const selected = tasks[Math.min(this.cursor, tasks.length - 1)];

    if (matchesKey(data, "e")) return this.beginEdit("prompt", selected);
    if (matchesKey(data, "f")) return this.beginEdit("frequency", selected);
    if (matchesKey(data, "d")) {
      this.mode = "confirmOne";
      this.notice = undefined;
      this.rerender();
      return;
    }
    if (matchesKey(data, "x")) {
      this.mode = "confirmAll";
      this.notice = undefined;
      this.rerender();
      return;
    }
    if (matchesKey(data, "r")) {
      this.notice = undefined;
      this.rerender();
      return;
    }
  }

  private beginEdit(field: "prompt" | "frequency", task: LoopTask): void {
    this.mode = "edit";
    this.editField = field;
    this.editBuffer = field === "prompt" ? task.prompt : task.cron;
    this.editError = undefined;
    this.notice = undefined;
    this.rerender();
  }

  private handleEditInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.mode = "list";
      this.editError = undefined;
      this.rerender();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.commitEdit();
      this.rerender();
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.editBuffer = this.editBuffer.slice(0, -1);
      this.editError = undefined;
      this.rerender();
      return;
    }
    if (isPrintable(data)) {
      this.editBuffer += data;
      this.editError = undefined;
      this.rerender();
    }
  }

  private commitEdit(): void {
    const task = this.tasks()[Math.min(this.cursor, this.tasks().length - 1)];
    if (!task) {
      this.mode = "list";
      return;
    }
    const result =
      this.editField === "prompt"
        ? applyPromptEdit(task, this.editBuffer)
        : applyFrequencyEdit(task, this.editBuffer);
    if (!result.ok) {
      this.editError = result.error;
      return;
    }
    updateTask(result.task);
    this.persistAndRefresh();
    this.notice = `Updated ${this.editField} for [${task.id}]`;
    this.mode = "list";
    this.editError = undefined;
  }

  private handleConfirmInput(data: string): void {
    if (matchesKey(data, "y")) {
      if (this.mode === "confirmAll") {
        const count = this.tasks().length;
        clearAllTasks();
        this.persistAndRefresh();
        this.notice = `Cancelled ${count} loop${count === 1 ? "" : "s"}`;
        this.cursor = 0;
      } else {
        const task = this.tasks()[Math.min(this.cursor, this.tasks().length - 1)];
        if (task) {
          removeTask(task.id);
          this.persistAndRefresh();
          this.notice = `Cancelled [${task.id}]`;
        }
      }
      this.mode = "list";
      this.rerender();
      return;
    }
    if (matchesKey(data, "n") || matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.mode = "list";
      this.rerender();
    }
  }

  private persistAndRefresh(): void {
    // Best-effort persistence (writeDurableTasks filters to durable tasks only,
    // so editing/cancelling a session task never accidentally persists it).
    writeDurableTasks(this.deps.getCwd(), this.deps.getConfig()).catch(() => {});
    this.deps.refreshStatus();
  }

  render(width: number): string[] {
    const th = this.theme;
    const boxWidth = Math.max(24, width);
    const inner = boxWidth - 2;
    const border = (s: string) => th.fg("border", s);
    const row = (content = "") => border("│") + truncateToWidth(content, inner, "", true) + border("│");
    const lines: string[] = [];

    const title = " Loops ";
    const titleWidth = visibleWidth(title);
    lines.push(border("╭") + th.fg("accent", title) + border("─".repeat(Math.max(0, inner - titleWidth)) + "╮"));

    const tasks = this.tasks();
    if (this.cursor > tasks.length - 1) this.cursor = Math.max(0, tasks.length - 1);

    const durable = tasks.filter((t) => t.durable).length;
    const sched = this.deps.schedulerRunning() ? th.fg("success", "● running") : th.fg("warning", "○ stopped");
    lines.push(
      row(
        ` ${th.fg("muted", `${tasks.length} loop${tasks.length === 1 ? "" : "s"}`)}` +
          ` · ${th.fg("muted", `${durable} durable`)} · ${th.fg("muted", "scheduler")} ${sched}`,
      ),
    );
    lines.push(row(""));

    if (tasks.length === 0) {
      lines.push(row(`   ${th.fg("dim", "No active loops. Start one with /loop <interval> <prompt>.")}`));
      lines.push(row(""));
      lines.push(row(` ${th.fg("dim", "esc close")}`));
      lines.push(border("╰" + "─".repeat(inner) + "╯"));
      return lines;
    }

    const now = Date.now();
    tasks.forEach((t, i) => {
      const isCursor = i === this.cursor;
      const mark = isCursor ? th.fg("accent", "›") : " ";
      const next = taskNextFireMs(t, now);
      const nextStr = next ? formatDuration(next - now) : "unknown";
      const idText = isCursor ? th.fg("accent", th.bold(`[${t.id}]`)) : th.bold(`[${t.id}]`);
      lines.push(row(` ${mark} ${idText} ${th.fg("muted", cronToHuman(t.cron))} ${th.fg("dim", "· next")} ${nextStr}`));
      const flags = [t.recurring ? "recurring" : "one-shot", t.durable ? "durable" : "session"].join(" · ");
      const label = t.label ? th.fg("muted", `${t.label}: `) : "";
      const preview = t.prompt.replace(/\s+/g, " ").trim();
      lines.push(row(`     ${label}${th.fg("dim", `"${preview}"`)}`));
      lines.push(row(`       ${th.fg("dim", flags)}`));
    });
    lines.push(row(""));

    if (this.mode === "edit") {
      const t = tasks[Math.min(this.cursor, tasks.length - 1)];
      lines.push(row(` ${th.fg("accent", `Edit ${this.editField}`)} ${th.fg("dim", `[${t?.id ?? ""}]`)}`));
      lines.push(row(` ${border("> ")}${this.editBuffer}${th.fg("accent", "▏")}`));
      if (this.editError) lines.push(row(` ${th.fg("error", this.editError)}`));
      lines.push(row(` ${th.fg("dim", "enter save · esc cancel")}`));
    } else if (this.mode === "confirmOne") {
      const t = tasks[Math.min(this.cursor, tasks.length - 1)];
      const preview = (t?.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
      lines.push(row(` ${th.fg("warning", `Cancel [${t?.id ?? ""}]?`)} ${th.fg("dim", `"${preview}"`)}`));
      lines.push(row(` ${th.fg("dim", "y confirm · n cancel")}`));
    } else if (this.mode === "confirmAll") {
      lines.push(row(` ${th.fg("warning", `Cancel ALL ${tasks.length} loop${tasks.length === 1 ? "" : "s"}?`)}`));
      lines.push(row(` ${th.fg("dim", "y confirm · n cancel")}`));
    } else {
      if (this.notice) lines.push(row(` ${th.fg("success", this.notice)}`));
      lines.push(row(` ${th.fg("dim", "↑↓ move · e edit · f freq · d cancel · x all · r refresh · esc close")}`));
    }

    lines.push(border("╰" + "─".repeat(inner) + "╯"));
    return lines;
  }
}
