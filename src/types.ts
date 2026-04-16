import { Type, type Static } from "@sinclair/typebox";

// --- LoopTask schema (TypeBox for tool parameters) ---

export const LoopTaskSchema = Type.Object({
  id: Type.String(),
  cron: Type.String(),
  prompt: Type.String(),
  createdAt: Type.Number(),
  lastFiredAt: Type.Optional(Type.Number()),
  nextFireTime: Type.Optional(Type.Number()),  // Computed at creation for one-shots; enables missed-fire detection
  recurring: Type.Boolean(),
  durable: Type.Boolean(),
  label: Type.Optional(Type.String()),
});

export type LoopTask = Static<typeof LoopTaskSchema>;

// --- Configuration ---

export interface LoopConfig {
  maxJobs: number;
  recurringMaxAgeMs: number;
  recurringJitterFrac: number;
  recurringJitterCapMs: number;
  oneShotJitterMaxMs: number;
  oneShotJitterFloorMs: number;
  oneShotJitterMinuteMod: number;
  checkIntervalMs: number;
  durableFilePath: string;
}

export const DEFAULT_CONFIG: LoopConfig = {
  maxJobs: 50,
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  recurringJitterFrac: 0.1,
  recurringJitterCapMs: 15 * 60 * 1000,
  oneShotJitterMaxMs: 90 * 1000,
  oneShotJitterFloorMs: 0,
  oneShotJitterMinuteMod: 30,
  checkIntervalMs: 1000,
  durableFilePath: ".pi-loop.json",
};

// --- Durable file format ---

export interface DurableFile {
  tasks: LoopTask[];
}
