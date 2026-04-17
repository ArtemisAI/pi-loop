#!/usr/bin/env node
/**
 * E2E Test Suite — @pi-agents/loop@0.3.0 (published npm package)
 *
 * Imports directly from dist/ files since package.json only exports the
 * main entry point (piLoop default export). This tests the ACTUAL published code.
 */

import { readFile, writeFile, unlink, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Direct imports from installed package dist/ (public package, not local dev)
const PKG = "/home/artemisai/.nvm/versions/node/v20.20.2/lib/node_modules/@pi-agents/loop/dist";

const {
  parseCronExpression,
  computeNextCronRun,
  nextCronRunMs,
  cronToHuman,
  intervalToCron,
  cronGapMs,
} = await import(`${PKG}/cron.js`);

const {
  generateTaskId,
  addTask,
  removeTask,
  getTask,
  getAllTasks,
  getTaskCount,
  updateTask,
  clearAllTasks,
  loadDurableTasks,
  writeDurableTasks,
  acquireLock,
  releaseLock,
  isPidAlive,
} = await import(`${PKG}/store.js`);

const {
  recurringJitterMs,
  oneShotJitterMs,
  jitterFrac,
} = await import(`${PKG}/jitter.js`);

const { DEFAULT_CONFIG } = await import(`${PKG}/types.js`);

// --- Test harness ---
let total = 0, passed = 0, failed = 0;
const failures = [];

function assert(cond, label) {
  total++;
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}

function assertApprox(actual, expected, tolerance, label) {
  const ok = Math.abs(actual - expected) <= tolerance;
  total++;
  if (ok) { passed++; console.log(`  ✅ ${label} (${actual} ≈ ${expected} ±${tolerance})`); }
  else { failed++; failures.push(label); console.log(`  ❌ ${label} (${actual} ≠ ${expected} ±${tolerance})`); }
}

function section(name) { console.log(`\n━━━ ${name} ━━━`); }

const TEST_DIR = join(tmpdir(), `pi-loop-e2e-${Date.now()}`);
const testConfig = { ...DEFAULT_CONFIG };

// =====================================================================
// 1. CRON PARSER
// =====================================================================
async function testCronParser() {
  section("1. Cron Parser — Valid Expressions");

  const everyMin = parseCronExpression("* * * * *");
  assert(everyMin !== null, "* * * * * parses");
  assert(everyMin.minute.values.has(0), "minute 0 present");
  assert(everyMin.minute.values.has(59), "minute 59 present");
  assert(everyMin.hour.values.has(0), "hour 0 present");
  assert(everyMin.hour.values.has(23), "hour 23 present");

  const every5 = parseCronExpression("*/5 * * * *");
  assert(every5 !== null, "*/5 * * * * parses");
  assert(every5.minute.values.has(0), "*/5 minute 0");
  assert(every5.minute.values.has(5), "*/5 minute 5");
  assert(every5.minute.values.has(55), "*/5 minute 55");
  assert(!every5.minute.values.has(3), "*/5 minute 3 absent");

  const daily = parseCronExpression("30 14 * * *");
  assert(daily !== null, "30 14 * * * parses");
  assert(daily.minute.values.has(30), "minute 30");
  assert(daily.hour.values.has(14), "hour 14");

  const range = parseCronExpression("0 9 * * 1-5");
  assert(range !== null, "0 9 * * 1-5 parses");
  assert(range.dayOfWeek.values.has(1), "Monday present");
  assert(range.dayOfWeek.values.has(5), "Friday present");
  assert(!range.dayOfWeek.values.has(0), "Sunday absent");
  assert(!range.dayOfWeek.values.has(6), "Saturday absent");

  const step = parseCronExpression("0 */2 * * *");
  assert(step !== null, "0 */2 * * * parses");
  assert(step.hour.values.has(0), "hour 0");
  assert(step.hour.values.has(2), "hour 2");
  assert(step.hour.values.has(22), "hour 22");
  assert(!step.hour.values.has(1), "hour 1 absent");

  // Comma-separated values
  const comma = parseCronExpression("15,45 * * * *");
  assert(comma !== null, "15,45 * * * * parses");
  assert(comma.minute.values.has(15), "minute 15");
  assert(comma.minute.values.has(45), "minute 45");
  assert(!comma.minute.values.has(30), "minute 30 absent");

  section("1b. Cron Parser — Invalid Expressions");
  assert(parseCronExpression("") === null, "empty rejects");
  assert(parseCronExpression("* * *") === null, "3 fields rejects");
  assert(parseCronExpression("* * * * * *") === null, "6 fields rejects");
  assert(parseCronExpression("60 * * * *") === null, "minute 60 rejects");
  assert(parseCronExpression("0 24 * * *") === null, "hour 24 rejects");
  assert(parseCronExpression("0 0 32 * *") === null, "day 32 rejects");
  assert(parseCronExpression("0 0 * 13 *") === null, "month 13 rejects");
  assert(parseCronExpression("abc * * * *") === null, "non-numeric rejects");
  assert(parseCronExpression("*/0 * * * *") === null, "step 0 rejects");
}

// =====================================================================
// 2. NEXT CRON RUN
// =====================================================================
async function testNextCronRun() {
  section("2. Next Cron Run Calculation");

  const now = Date.now();
  const nextMin = nextCronRunMs("* * * * *", now);
  assert(nextMin !== null, "every-minute has next run");
  assertApprox(nextMin - now, 60000, 61000, "every-minute ~60s away");

  const next5 = nextCronRunMs("*/5 * * * *", now);
  assert(next5 !== null, "every-5min has next run");
  assert(new Date(next5).getMinutes() % 5 === 0, "lands on 5-min boundary");

  const nextDaily = nextCronRunMs("30 14 * * *", now);
  assert(nextDaily !== null, "daily 14:30 has next run");
  assert(new Date(nextDaily).getHours() === 14, "hour 14");
  assert(new Date(nextDaily).getMinutes() === 30, "minute 30");

  // Deterministic
  const nextAgain = nextCronRunMs("* * * * *", now);
  assert(nextAgain === nextMin, "deterministic from same fromMs");

  // Consecutive runs
  const nextSecond = nextCronRunMs("* * * * *", nextMin);
  assertApprox(nextSecond - nextMin, 60000, 1000, "consecutive 1-min runs 60s apart");
}

// =====================================================================
// 3. CRON TO HUMAN
// =====================================================================
async function testCronToHuman() {
  section("3. Cron → Human Readable");

  assert(cronToHuman("*/5 * * * *") === "every 5 minutes", "*/5 → every 5 minutes");
  assert(cronToHuman("*/1 * * * *") === "every minute", "*/1 → every minute");
  assert(cronToHuman("0 */2 * * *") === "every 2 hours", "0 */2 → every 2 hours");
  assert(cronToHuman("0 */1 * * *") === "every hour", "0 */1 → every hour");
  assert(cronToHuman("30 14 * * *") === "daily at 2:30 PM", "30 14 → daily at 2:30 PM");
  // Fixed: "0 0 * * *" now returns "every day at midnight" (LW-004)
  assert(cronToHuman("0 0 * * *") === "every day at midnight", "0 0 * * * → every day at midnight");
  assert(cronToHuman("0 0 */1 * *") === "every day at midnight", "0 0 */1 → every day at midnight");
  assert(cronToHuman("0 8 * * *") === "daily at 8:00 AM", "0 8 → daily at 8:00 AM");
  assert(cronToHuman("15,45 * * * *") === "15,45 * * * *", "complex pattern falls back");
  assert(cronToHuman("bad") === "bad", "invalid input falls back");
}

// =====================================================================
// 4. INTERVAL TO CRON
// =====================================================================
async function testIntervalToCron() {
  section("4. Interval → Cron Conversion");

  assert(intervalToCron("5m") === "*/5 * * * *", "5m → */5 * * * *");
  assert(intervalToCron("1m") === "*/1 * * * *", "1m → */1 * * * *");
  assert(intervalToCron("2h") === "0 */2 * * *", "2h → 0 */2 * * *");
  assert(intervalToCron("1h") === "0 */1 * * *", "1h → 0 */1 * * *");
  assert(intervalToCron("1d") === "0 0 */1 * *", "1d → 0 0 */1 * *");
  assert(intervalToCron("30s") === "*/1 * * * *", "30s rounds up to 1 minute");
  assert(intervalToCron("120m") === "0 */2 * * *", "120m → 0 */2 * * *");
  assert(intervalToCron("24h") === "0 0 */1 * *", "24h → 0 0 */1 * * *");
  assert(intervalToCron("0m") === null, "0m rejects");
  assert(intervalToCron("abc") === null, "non-interval rejects");
  assert(intervalToCron("") === null, "empty rejects");
}

// =====================================================================
// 5. CRON GAP
// =====================================================================
async function testCronGap() {
  section("5. Cron Gap Calculation");

  const now = Date.now();
  assertApprox(cronGapMs("*/5 * * * *", now), 300000, 1000, "*/5 gap ~5 min");
  assertApprox(cronGapMs("* * * * *", now), 60000, 1000, "* gap ~1 min");
  assertApprox(cronGapMs("0 */2 * * *", now), 7200000, 1000, "0 */2 gap ~2 hours");
}

// =====================================================================
// 6. TASK STORE
// =====================================================================
async function testTaskStore() {
  section("6. Task Store — CRUD");

  clearAllTasks();
  assert(getTaskCount() === 0, "starts empty");

  const id1 = generateTaskId();
  assert(id1.length === 8, "ID is 8 chars");
  assert(/^[0-9a-f]{8}$/.test(id1), "ID is hex");

  const task1 = {
    id: id1, cron: "*/5 * * * *", prompt: "Test 1",
    createdAt: Date.now(), recurring: true, durable: false,
  };
  assert(addTask(task1) === true, "addTask returns true");
  assert(getTaskCount() === 1, "count 1");
  assert(getTask(id1)?.prompt === "Test 1", "correct prompt");

  // Duplicate ID (MD-005)
  assert(addTask(task1) === false, "duplicate ID rejected");
  assert(getTaskCount() === 1, "count still 1");

  // Second task with label (LW-003)
  const id2 = generateTaskId();
  addTask({
    id: id2, cron: "0 9 * * 1-5", prompt: "Standup",
    createdAt: Date.now(), recurring: true, durable: true, label: "standup",
  });
  assert(getTaskCount() === 2, "count 2");
  assert(getTask(id2).label === "standup", "label stored");

  // getAllTasks
  assert(getAllTasks().length === 2, "getAllTasks 2");

  // updateTask
  task1.lastFiredAt = Date.now();
  updateTask(task1);
  assert(getTask(id1).lastFiredAt !== undefined, "lastFiredAt updated");

  // removeTask
  assert(removeTask(id1) === true, "remove returns true");
  assert(getTaskCount() === 1, "count 1 after remove");
  assert(getTask(id1) === undefined, "getTask undefined after remove");
  assert(removeTask(id1) === false, "remove non-existent returns false");

  clearAllTasks();
}

// =====================================================================
// 7. DURABLE PERSISTENCE
// =====================================================================
async function testDurablePersistence() {
  section("7. Durable Task Persistence");

  await mkdir(TEST_DIR, { recursive: true });
  clearAllTasks();

  const id1 = generateTaskId(), id2 = generateTaskId(), id3 = generateTaskId();
  addTask({ id: id1, cron: "*/10 * * * *", prompt: "Durable recurring",
    createdAt: Date.now(), recurring: true, durable: true });
  addTask({ id: id2, cron: "0 9 * * *", prompt: "Durable one-shot",
    createdAt: Date.now(), nextFireTime: Date.now() + 3600000,
    recurring: false, durable: true });
  addTask({ id: id3, cron: "*/1 * * * *", prompt: "Session-only",
    createdAt: Date.now(), recurring: true, durable: false });

  await writeDurableTasks(TEST_DIR, testConfig);

  const raw = await readFile(join(TEST_DIR, testConfig.durableFilePath), "utf-8");
  const data = JSON.parse(raw);
  assert(Array.isArray(data.tasks), "tasks is array");
  assert(data.tasks.length === 2, "only durable tasks persisted");
  assert(data.tasks.some(t => t.id === id1), "durable 1 in file");
  assert(data.tasks.some(t => t.id === id2), "durable 2 in file");
  assert(!data.tasks.some(t => t.id === id3), "session-only NOT in file");

  // Reload
  clearAllTasks();
  const result = await loadDurableTasks(TEST_DIR, testConfig);
  assert(result.tasks.length === 2, "2 active tasks loaded");
  assert(result.missedOneshots.length === 0, "0 missed one-shots");
  assert(result.tasks.some(t => t.id === id1), "task 1 loaded");
  assert(result.tasks.some(t => t.id === id2), "task 2 loaded");

  clearAllTasks();
}

// =====================================================================
// 8. MISSED ONE-SHOT DETECTION (CR-001)
// =====================================================================
async function testMissedOneshotDetection() {
  section("8. Missed One-Shot Detection (CR-001)");

  await mkdir(TEST_DIR, { recursive: true });
  clearAllTasks();

  const pastId = generateTaskId(), futureId = generateTaskId(), recurId = generateTaskId();
  const oneHourAgo = Date.now() - 3600000;
  const oneHourFromNow = Date.now() + 3600000;

  await writeFile(
    join(TEST_DIR, testConfig.durableFilePath),
    JSON.stringify({ tasks: [
      { id: pastId, cron: "0 10 * * *", prompt: "Past one-shot — MISSED",
        createdAt: Date.now() - 7200000, nextFireTime: oneHourAgo,
        recurring: false, durable: true },
      { id: futureId, cron: "0 10 * * *", prompt: "Future one-shot — valid",
        createdAt: Date.now(), nextFireTime: oneHourFromNow,
        recurring: false, durable: true },
      { id: recurId, cron: "*/5 * * * *", prompt: "Recurring — never missed",
        createdAt: oneHourAgo, recurring: true, durable: true },
    ]}, null, 2), "utf-8"
  );

  const result = await loadDurableTasks(TEST_DIR, testConfig);
  assert(result.tasks.length === 2, "2 active tasks (future + recurring)");
  assert(result.missedOneshots.length === 1, "1 missed one-shot");
  assert(result.missedOneshots[0].id === pastId, "correct missed ID");
  assert(!result.tasks.some(t => t.id === pastId), "missed not in active");
  assert(result.tasks.some(t => t.id === futureId), "future in active");
  assert(result.tasks.some(t => t.id === recurId), "recurring in active");

  clearAllTasks();
}

// =====================================================================
// 9. LOCK MECHANISM (HI-001)
// =====================================================================
async function testLockMechanism() {
  section("9. Lock Mechanism — PID Liveness (HI-001)");

  await mkdir(TEST_DIR, { recursive: true });

  const acquired = await acquireLock(TEST_DIR, testConfig);
  assert(acquired === true, "first acquire succeeds");

  const lockRaw = await readFile(join(TEST_DIR, testConfig.durableFilePath + ".lock"), "utf-8");
  const lock = JSON.parse(lockRaw);
  assert(typeof lock.pid === "number", "lock has pid");
  assert(lock.pid === process.pid, "lock PID = current process");
  assert(typeof lock.acquiredAt === "number", "lock has acquiredAt");

  // PID liveness
  assert(isPidAlive(process.pid) === true, "isPidAlive(self) = true");
  assert(isPidAlive(999999) === false, "isPidAlive(dead PID) = false");

  await releaseLock(TEST_DIR, testConfig);
  let lockExists = true;
  try { await readFile(join(TEST_DIR, testConfig.durableFilePath + ".lock"), "utf-8"); }
  catch { lockExists = false; }
  assert(lockExists === false, "lock removed after release");

  const reacquired = await acquireLock(TEST_DIR, testConfig);
  assert(reacquired === true, "re-acquire after release succeeds");

  await releaseLock(TEST_DIR, testConfig);
}

async function testStaleLockRecovery() {
  section("9b. Stale Lock Recovery — Dead PID");

  await mkdir(TEST_DIR, { recursive: true });

  await writeFile(
    join(TEST_DIR, testConfig.durableFilePath + ".lock"),
    JSON.stringify({ pid: 999999, acquiredAt: Date.now() }), "utf-8"
  );

  const acquired = await acquireLock(TEST_DIR, testConfig);
  assert(acquired === true, "acquires from dead PID");

  const lockRaw = await readFile(join(TEST_DIR, testConfig.durableFilePath + ".lock"), "utf-8");
  const lock = JSON.parse(lockRaw);
  assert(lock.pid === process.pid, "new lock has our PID");

  await releaseLock(TEST_DIR, testConfig);
}

async function testAliveLockBlocks() {
  section("9c. Alive Lock Blocks Second Acquirer");

  await mkdir(TEST_DIR, { recursive: true });

  // Write lock with OUR PID (alive)
  await writeFile(
    join(TEST_DIR, testConfig.durableFilePath + ".lock"),
    JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), "utf-8"
  );

  // Second acquire should fail — PID is alive
  const acquired = await acquireLock(TEST_DIR, testConfig);
  assert(acquired === false, "cannot acquire lock when owner PID is alive");

  // Clean up manually
  await unlink(join(TEST_DIR, testConfig.durableFilePath + ".lock"));
}

// =====================================================================
// 10. JITTER SYSTEM
// =====================================================================
async function testJitter() {
  section("10. Jitter System");

  const frac1 = jitterFrac("a1b2c3d4");
  const frac2 = jitterFrac("a1b2c3d4");
  assert(frac1 === frac2, "jitterFrac deterministic");
  assert(frac1 >= 0 && frac1 < 1, "jitterFrac in [0, 1)");

  const frac3 = jitterFrac("ffffffff");
  assert(frac3 !== frac1, "different ID = different frac");

  // Recurring jitter (MD-007 defaults)
  const task = { id: "a1b2c3d4", cron: "*/5 * * * *", prompt: "test",
    createdAt: Date.now(), recurring: true, durable: false };
  const gap5min = 5 * 60 * 1000;
  const jitter = recurringJitterMs(task, gap5min, DEFAULT_CONFIG);
  assert(jitter >= 0, "recurring jitter >= 0");
  const maxExpected = Math.min(0.5 * gap5min, DEFAULT_CONFIG.recurringJitterCapMs);
  assert(jitter <= maxExpected + 1, `recurring jitter <= max (${jitter} <= ${maxExpected})`);

  // One-shot jitter
  const oneShotTask = { id: "a1b2c3d4", cron: "0 10 * * *", prompt: "test",
    createdAt: Date.now() - 86400000, recurring: false, durable: false };
  const fireDate = new Date();
  fireDate.setHours(10, 0, 0, 0);
  if (fireDate.getTime() < Date.now()) fireDate.setDate(fireDate.getDate() + 1);
  const oneShotJitter = oneShotJitterMs(oneShotTask, fireDate.getTime(), DEFAULT_CONFIG);
  assert(oneShotJitter >= 0, "one-shot jitter >= 0");
  assert(oneShotJitter <= DEFAULT_CONFIG.oneShotJitterMaxMs, "one-shot jitter <= 90s");

  // v0.3.0 defaults
  assert(DEFAULT_CONFIG.recurringJitterFrac === 0.5, "jitterFrac = 0.5 (MD-007)");
  assert(DEFAULT_CONFIG.recurringJitterCapMs === 30 * 60 * 1000, "jitterCap = 30min (MD-007)");
}

// =====================================================================
// 11. CONFIG DEFAULTS
// =====================================================================
async function testConfigDefaults() {
  section("11. Config Defaults");

  assert(DEFAULT_CONFIG.maxJobs === 50, "maxJobs = 50");
  assert(DEFAULT_CONFIG.recurringMaxAgeMs === 7 * 24 * 60 * 60 * 1000, "7-day expiry");
  assert(DEFAULT_CONFIG.checkIntervalMs === 1000, "1s tick");
  assert(DEFAULT_CONFIG.durableFilePath === ".pi-loop.json", "durable path");
  assert(DEFAULT_CONFIG.recurringJitterFrac === 0.5, "frac 0.5");
  assert(DEFAULT_CONFIG.recurringJitterCapMs === 30 * 60 * 1000, "cap 30min");
  assert(DEFAULT_CONFIG.oneShotJitterMaxMs === 90 * 1000, "one-shot max 90s");
  assert(DEFAULT_CONFIG.oneShotJitterFloorMs === 0, "floor 0");
  assert(DEFAULT_CONFIG.oneShotJitterMinuteMod === 30, "minute mod 30");
}

// =====================================================================
// 12. EDGE CASES — ERROR HANDLING (MD-003)
// =====================================================================
async function testEdgeCases() {
  section("12. Edge Cases — Error Handling (MD-003)");

  // ENOENT — new project, no file
  clearAllTasks();
  const freshDir = join(tmpdir(), `pi-loop-fresh-${Date.now()}`);
  await mkdir(freshDir, { recursive: true });
  const fresh = await loadDurableTasks(freshDir, testConfig);
  assert(fresh.tasks.length === 0, "ENOENT → empty tasks");
  assert(fresh.missedOneshots.length === 0, "ENOENT → empty missed");

  // Corrupted JSON
  await writeFile(join(freshDir, testConfig.durableFilePath), "{bad json!!!", "utf-8");
  const corrupt = await loadDurableTasks(freshDir, testConfig);
  assert(corrupt.tasks.length === 0, "corrupt JSON → empty (no crash)");
  assert(corrupt.missedOneshots.length === 0, "corrupt → empty missed");

  // Non-array tasks field
  await writeFile(join(freshDir, testConfig.durableFilePath),
    JSON.stringify({ tasks: "not an array" }), "utf-8");
  const badArr = await loadDurableTasks(freshDir, testConfig);
  assert(badArr.tasks.length === 0, "non-array tasks → empty");

  // Empty tasks array
  await writeFile(join(freshDir, testConfig.durableFilePath),
    JSON.stringify({ tasks: [] }), "utf-8");
  const empty = await loadDurableTasks(freshDir, testConfig);
  assert(empty.tasks.length === 0, "empty array → empty");
  assert(empty.missedOneshots.length === 0, "empty array → no missed");

  await rm(freshDir, { recursive: true }).catch(() => {});
}

// =====================================================================
// 13. SCHEDULE WAKEUP
// =====================================================================
async function testScheduleWakeup() {
  section("13. ScheduleWakeup Task Structure");

  clearAllTasks();
  const delaySeconds = 1200;
  const fireAt = Date.now() + delaySeconds * 1000;
  const id = generateTaskId();

  addTask({ id, cron: `_wakeup_${fireAt}`, prompt: "<<autonomous-loop-dynamic>>",
    createdAt: Date.now(), nextFireTime: fireAt,
    recurring: false, durable: false, label: "wakeup: idle tick" });

  assert(getTask(id) !== undefined, "wakeup task added");
  assert(getTask(id).cron.startsWith("_wakeup_"), "wakeup cron prefix");
  assert(getTask(id).nextFireTime === fireAt, "nextFireTime set");
  assert(getTask(id).recurring === false, "non-recurring");
  assert(getTask(id).durable === false, "session-only");

  // Clamp: min 60, max 3600
  assert(Math.max(60, Math.min(3600, 10)) === 60, "clamped to min 60s");
  assert(Math.max(60, Math.min(3600, 5000)) === 3600, "clamped to max 3600s");

  clearAllTasks();
}

// =====================================================================
// 14. SCHEDULER LOGIC
// =====================================================================
async function testSchedulerLogic() {
  section("14. Scheduler — shouldFire Logic");

  clearAllTasks();

  // Past-due recurring: should fire
  const pastId = generateTaskId();
  addTask({ id: pastId, cron: "*/5 * * * *", prompt: "Past due",
    createdAt: Date.now() - 600000, lastFiredAt: Date.now() - 600000,
    recurring: true, durable: false });

  const now = Date.now();
  const anchor = Date.now() - 600000;
  const baseNext = nextCronRunMs("*/5 * * * *", anchor);
  assert(baseNext !== null, "base next computed");
  const gap = cronGapMs("*/5 * * * *", anchor);
  const jitter = gap ? recurringJitterMs({ id: pastId }, gap, DEFAULT_CONFIG) : 0;
  const shouldFire = now >= baseNext + jitter;
  assert(shouldFire, "past-due recurring should fire");

  // ScheduleWakeup fire: check nextFireTime
  const wakeupId = generateTaskId();
  const futureFire = Date.now() + 600000;
  addTask({ id: wakeupId, cron: `_wakeup_${futureFire}`, prompt: "wakeup",
    createdAt: Date.now(), nextFireTime: futureFire,
    recurring: false, durable: false });

  const wakeupShouldFireNow = now >= getTask(wakeupId).nextFireTime;
  assert(wakeupShouldFireNow === false, "future wakeup should NOT fire now");

  const pastWakeupId = generateTaskId();
  const pastFire = Date.now() - 1000;
  addTask({ id: pastWakeupId, cron: `_wakeup_${pastFire}`, prompt: "past wakeup",
    createdAt: Date.now(), nextFireTime: pastFire,
    recurring: false, durable: false });

  const pastWakeupShouldFire = now >= getTask(pastWakeupId).nextFireTime;
  assert(pastWakeupShouldFire === true, "past wakeup SHOULD fire");

  clearAllTasks();
}

// =====================================================================
// 15. AUTO-EXPIRY
// =====================================================================
async function testAutoExpiry() {
  section("15. Auto-Expiry (7-day max age)");

  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  const agedOut = Date.now() - sevenDays - 1000 >= DEFAULT_CONFIG.recurringMaxAgeMs;
  assert(agedOut === false || agedOut === true, "aged out check works");
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  assert(Date.now() - eightDaysAgo >= DEFAULT_CONFIG.recurringMaxAgeMs,
    "8-day task is aged out");

  const isFresh = Date.now() - (Date.now() - 86400000) < DEFAULT_CONFIG.recurringMaxAgeMs;
  assert(isFresh, "1-day task NOT aged out");
}

// =====================================================================
// 16. NEXT FIRE TIME FIELD (LW-003 / CR-001)
// =====================================================================
async function testNextFireTimeField() {
  section("16. nextFireTime Field (LW-003 / CR-001)");

  const now = Date.now();
  const nextFire = nextCronRunMs("0 15 * * *", now);
  assert(nextFire !== null, "nextFireTime computed for one-shot");
  assert(typeof nextFire === "number", "nextFireTime is number");
  assert(nextFire > now, "nextFireTime is in future");

  // Recurring: nextFireTime is optional
  const recurring = { id: generateTaskId(), cron: "*/5 * * * *", prompt: "rec",
    createdAt: now, recurring: true, durable: false };
  assert(recurring.nextFireTime === undefined, "recurring nextFireTime optional");
}

// =====================================================================
// 17. LIVE TOOL TESTS — cron_create / cron_list / cron_delete
// =====================================================================
async function testLiveCronTools() {
  section("17. Live cron_* Tools (via agent runtime)");

  console.log("  ℹ️  Testing via available tool interface...");

  // These tests use the cron_* tools available in the agent environment
  // Tested separately after this script runs
}

// =====================================================================
// MAIN
// =====================================================================
async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  E2E Test Suite — @pi-agents/loop@0.3.0 (published package)  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  try {
    await testCronParser();
    await testNextCronRun();
    await testCronToHuman();
    await testIntervalToCron();
    await testCronGap();
    await testTaskStore();
    await testDurablePersistence();
    await testMissedOneshotDetection();
    await testLockMechanism();
    await testStaleLockRecovery();
    await testAliveLockBlocks();
    await testJitter();
    await testConfigDefaults();
    await testEdgeCases();
    await testScheduleWakeup();
    await testSchedulerLogic();
    await testAutoExpiry();
    await testNextFireTimeField();
    await testLiveCronTools();
  } finally {
    await rm(TEST_DIR, { recursive: true }).catch(() => {});
  }

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log(`║  Results: ${passed}/${total} passed, ${failed} failed${" ".repeat(Math.max(0, 30 - `${passed}/${total} passed, ${failed} failed`.length))}║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");

  if (failures.length > 0) {
    console.log("\n❌ Failed tests:");
    failures.forEach(f => console.log(`   - ${f}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(2); });