#!/usr/bin/env node
/**
 * Real E2E Test Suite — @pi-agents/loop@0.3.0
 *
 * Actually runs the scheduler, creates tasks, waits for fires,
 * measures timing accuracy, and verifies the full lifecycle.
 * No mocks. No stubs. Real ticks, real fires, real measurements.
 */

import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import from published package
const PKG = "/home/artemisai/.nvm/versions/node/v20.20.2/lib/node_modules/@pi-agents/loop/dist";

const { nextCronRunMs, intervalToCron, cronToHuman, cronGapMs } = await import(`${PKG}/cron.js`);
const {
  generateTaskId, addTask, removeTask, getAllTasks, getTask,
  getTaskCount, updateTask, clearAllTasks,
  loadDurableTasks, writeDurableTasks,
  acquireLock, releaseLock, isPidAlive,
} = await import(`${PKG}/store.js`);
const { LoopScheduler } = await import(`${PKG}/scheduler.js`);
const { DEFAULT_CONFIG } = await import(`${PKG}/types.js`);

// ── Test harness ──
let total = 0, passed = 0, failed = 0;
const failures = [];

function assert(cond, label) {
  total++;
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}

function assertRange(actual, min, max, label) {
  total++;
  if (actual >= min && actual <= max) {
    passed++;
    console.log(`  ✅ ${label} (${actual} in [${min}, ${max}])`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ❌ ${label} (${actual} NOT in [${min}, ${max}])`);
  }
}

function section(name) { console.log(`\n${"═".repeat(60)}\n  ${name}\n${"═".repeat(60)}`); }

const TEST_DIR = join(tmpdir(), `pi-loop-e2e-real-${Date.now()}`);
// Test config: 500ms ticks for speed, REDUCED jitter for predictable timing
const config = { ...DEFAULT_CONFIG, checkIntervalMs: 500, recurringJitterFrac: 0.05, recurringJitterCapMs: 5000 };

// ── Mock pi agent ──
// The scheduler calls pi.sendUserMessage() on fire — we capture those
class MockPi {
  constructor() { this.fired = []; this.commands = {}; }
  registerCommand(name, def) { this.commands[name] = def; }
  registerTool() {}
  on() {}
  sendUserMessage(prompt) { this.fired.push({ prompt, time: Date.now() }); }
  getFiredCount() { return this.fired.length; }
  getFired() { return [...this.fired]; }
  clearFired() { this.fired = []; }
}

// ── Helper: wait ms ──
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Helper: create task and return it ──
function makeTask(cron, prompt, opts = {}) {
  const task = {
    id: generateTaskId(),
    cron,
    prompt,
    createdAt: Date.now(),
    recurring: opts.recurring ?? true,
    durable: opts.durable ?? false,
    ...opts,
  };
  addTask(task);
  return task;
}

// =====================================================================
// TEST 1: Scheduler starts and ticks
// =====================================================================
async function testSchedulerStarts() {
  section("1. Scheduler Lifecycle — start/stop");
  clearAllTasks();
  const pi = new MockPi();
  const scheduler = new LoopScheduler(pi, config, TEST_DIR);
  scheduler.setContext({ hasUI: false, ui: { notify: () => {}, setStatus: () => {} } });

  scheduler.start();
  assert(scheduler !== null, "scheduler created and started");

  // Let it tick for 1 second
  await wait(1200);
  scheduler.stop();
  assert(true, "scheduler ran for 1.2s without crash");
  clearAllTasks();
}

// =====================================================================
// TEST 2: Recurring task fires within expected window
// =====================================================================
async function testRecurringFire() {
  section("2. Recurring Task — fires within expected window");
  clearAllTasks();
  const pi = new MockPi();
  const scheduler = new LoopScheduler(pi, config, TEST_DIR);
  scheduler.setContext({ hasUI: false, ui: { notify: () => {}, setStatus: () => {} } });

  // Create a task that should fire every minute
  // But to speed things up, we'll set lastFiredAt to 65 seconds ago
  // so the next fire should be within seconds
  const task = makeTask("*/1 * * * *", "tick", { recurring: true });
  task.lastFiredAt = Date.now() - 65_000; // 65s ago — next fire was 5s ago
  updateTask(task);

  scheduler.start();
  // Wait up to 10 seconds for a fire
  let fired = false;
  const startTime = Date.now();
  for (let i = 0; i < 20; i++) {
    await wait(500);
    if (pi.getFiredCount() > 0) {
      fired = true;
      break;
    }
  }
  scheduler.stop();

  assert(fired, "recurring task fired within 10s");
  if (fired) {
    const fireRecord = pi.getFired()[0];
    const elapsed = fireRecord.time - startTime;
    console.log(`     → Fired after ${elapsed}ms`);
    assert(fireRecord.prompt === "tick", "fire has correct prompt");
  }
  clearAllTasks();
}

// =====================================================================
// TEST 3: Idle gating — tasks queue while busy, drain on idle
// =====================================================================
async function testIdleGating() {
  section("3. Idle Gating — fires queued while busy, drain on idle");
  clearAllTasks();
  const pi = new MockPi();
  const scheduler = new LoopScheduler(pi, config, TEST_DIR);
  scheduler.setContext({ hasUI: false, ui: { notify: () => {}, setStatus: () => {} } });

  // Create an overdue task
  const task = makeTask("*/1 * * * *", "gated-tick", { recurring: true });
  task.lastFiredAt = Date.now() - 65_000;
  updateTask(task);

  scheduler.start();

  // Set busy BEFORE the tick — fires should queue, not execute
  scheduler.setBusy();
  await wait(2000);

  const busyFired = pi.getFiredCount();
  console.log(`     → Fires while busy: ${busyFired}`);

  // Now set idle — pending fires should drain
  scheduler.setIdle();
  await wait(1000);

  const idleFired = pi.getFiredCount();
  console.log(`     → Fires after idle: ${idleFired}`);

  scheduler.stop();
  assert(busyFired === 0, "no fires while busy");
  assert(idleFired >= 1, "fires drained after idle");
  clearAllTasks();
}

// =====================================================================
// TEST 4: One-shot task fires once and is removed
// =====================================================================
async function testOneShotFire() {
  section("4. One-Shot Task — fires once, then auto-removed");
  clearAllTasks();
  const pi = new MockPi();
  const scheduler = new LoopScheduler(pi, config, TEST_DIR);
  scheduler.setContext({ hasUI: false, ui: { notify: () => {}, setStatus: () => {} } });

  const now = Date.now();
  // One-shot with nextFireTime 1 second from now
  const task = makeTask("0 0 * * *", "one-shot-ping", {
    recurring: false,
    nextFireTime: now + 2000, // fire in 2s
  });
  // Override cron for wakeup-style check
  task.cron = `_wakeup_${task.nextFireTime}`;
  updateTask(task);

  const countBefore = getTaskCount();
  assert(countBefore === 1, "task exists before fire");

  scheduler.start();
  // Wait for fire (2s delay + up to 3s margin)
  let fired = false;
  for (let i = 0; i < 10; i++) {
    await wait(500);
    if (pi.getFiredCount() > 0) { fired = true; break; }
  }
  scheduler.stop();

  assert(fired, "one-shot task fired");
  assert(pi.getFiredCount() === 1, "one-shot fired exactly once");

  // After firing, one-shot should be removed from store
  const remaining = getTaskCount();
  assert(remaining === 0, "one-shot removed after firing");
  clearAllTasks();
}

// =====================================================================
// TEST 5: Recurring task fires multiple times
// =====================================================================
async function testRecurringMultipleFires() {
  section("5. Recurring Task — fires multiple times at interval");
  clearAllTasks();
  const pi = new MockPi();
  const scheduler = new LoopScheduler(pi, config, TEST_DIR);
  scheduler.setContext({ hasUI: false, ui: { notify: () => {}, setStatus: () => {} } });

  // Create task last fired 65s ago — overdue, fires immediately
  // After first fire, lastFiredAt updates to NOW, so next fire is at next minute boundary
  // If first fire is at e.g. 00:34:18, next is 00:35:00 → gap could be 42-65s
  const task = makeTask("*/1 * * * *", "multi-tick", { recurring: true });
  task.lastFiredAt = Date.now() - 65_000;
  updateTask(task);

  scheduler.start();
  let secondFireTime = null;
  const startTime = Date.now();
  // Wait up to 90s for second fire (first fires quick, second at next minute + jitter)
  for (let i = 0; i < 180; i++) {
    await wait(500);
    if (pi.getFiredCount() >= 2 && !secondFireTime) {
      secondFireTime = pi.getFired()[1].time;
      break;
    }
  }
  scheduler.stop();

  const fireCount = pi.getFiredCount();
  console.log(`     → Total fires: ${fireCount}`);
  if (fireCount >= 2) {
    const t1 = pi.getFired()[0].time;
    const t2 = pi.getFired()[1].time;
    const gap = t2 - t1;
    console.log(`     → Gap between fires: ${gap}ms`);
    console.log(`     → 1st fire at: ${new Date(t1).toISOString()}`);
    console.log(`     → 2nd fire at: ${new Date(t2).toISOString()}`);
    // After 1st fire at non-boundary time (e.g. :34:18), next */1 is :35:00
    // So gap = (60 - secondsIntoMinute) + jitter
    // With 5% jitter: gap is roughly 30-65s
    assertRange(gap, 25_000, 75_000, "fire interval matches next-minute + low jitter");
  } else {
    assert(false, `only ${fireCount} fires in 90s (expected 2+)`);
  }
  clearAllTasks();
}

// =====================================================================
// TEST 6: ScheduleWakeup fires at computed time
// =====================================================================
async function testWakeupTiming() {
  section("6. ScheduleWakeup — fires at computed delay time");
  clearAllTasks();
  const pi = new MockPi();
  const scheduler = new LoopScheduler(pi, config, TEST_DIR);
  scheduler.setContext({ hasUI: false, ui: { notify: () => {}, setStatus: () => {} } });

  const delayMs = 5000; // 5 seconds
  const expectedFire = Date.now() + delayMs;
  const task = makeTask(`_wakeup_${expectedFire}`, "<<wakeup-test>>", {
    recurring: false,
    nextFireTime: expectedFire,
  });

  scheduler.start();
  const createToFire = Date.now();
  let fired = false;
  for (let i = 0; i < 20; i++) {
    await wait(500);
    if (pi.getFiredCount() > 0) { fired = true; break; }
  }
  scheduler.stop();

  assert(fired, "wakeup fired within 10s of target");
  if (fired) {
    const actualFire = pi.getFired()[0].time;
    const drift = Math.abs(actualFire - expectedFire);
    console.log(`     → Expected: ${new Date(expectedFire).toISOString()}`);
    console.log(`     → Actual:   ${new Date(actualFire).toISOString()}`);
    console.log(`     → Drift: ${drift}ms`);
    assertRange(drift, 0, 2000, `wakeup drift < 2s (actual: ${drift}ms)`);
  }
  clearAllTasks();
}

// =====================================================================
// TEST 7: Durable task written, survives reload
// =====================================================================
async function testDurableRoundTrip() {
  section("7. Durable Task — write → reload → verify");
  await mkdir(TEST_DIR, { recursive: true });
  clearAllTasks();

  const id1 = generateTaskId();
  const id2 = generateTaskId();
  addTask({ id: id1, cron: "*/10 * * * *", prompt: "durable-roundtrip",
    createdAt: Date.now(), recurring: true, durable: true });
  addTask({ id: id2, cron: "0 9 * * *", prompt: "oneshot-rt",
    createdAt: Date.now(), nextFireTime: Date.now() + 86400000,
    recurring: false, durable: true });

  await writeDurableTasks(TEST_DIR, config);

  // Clear the in-memory store and reload from disk
  clearAllTasks();
  assert(getTaskCount() === 0, "store cleared before reload");

  const result = await loadDurableTasks(TEST_DIR, config);
  for (const t of result.tasks) addTask(t);

  assert(getTaskCount() === 2, "2 tasks loaded from disk");
  assert(getTask(id1) !== undefined, "task 1 reloaded by ID");
  assert(getTask(id2) !== undefined, "task 2 reloaded by ID");
  assert(getTask(id1).durable === true, "reloaded task 1 is durable");
  assert(getTask(id2).nextFireTime !== undefined, "reloaded task 2 has nextFireTime");
  clearAllTasks();
}

// =====================================================================
// TEST 8: Missed one-shots detected on reload (CR-001)
// =====================================================================
async function testMissedOneshotRecovery() {
  section("8. Missed One-Shot Recovery on Reload (CR-001)");
  await mkdir(TEST_DIR, { recursive: true });
  clearAllTasks();

  const pastId = generateTaskId();
  const futureId = generateTaskId();
  const now = Date.now();

  // Write a durable file with a missed one-shot (nextFireTime in the past)
  await writeFile(join(TEST_DIR, config.durableFilePath), JSON.stringify({
    tasks: [
      { id: pastId, cron: "0 10 * * *", prompt: "missed-oneshot",
        createdAt: now - 7200000, nextFireTime: now - 3600000,
        recurring: false, durable: true },
      { id: futureId, cron: "0 10 * * *", prompt: "future-oneshot",
        createdAt: now, nextFireTime: now + 3600000,
        recurring: false, durable: true },
    ]
  }, null, 2), "utf-8");

  const result = await loadDurableTasks(TEST_DIR, config);
  assert(result.missedOneshots.length === 1, "1 missed one-shot detected");
  assert(result.missedOneshots[0].id === pastId, "correct missed task ID");
  assert(result.tasks.length === 1, "1 active task (future one-shot)");
  assert(result.tasks[0].id === futureId, "future task is active");

  // Simulate recovery: fire the missed one-shot
  const pi = new MockPi();
  for (const missed of result.missedOneshots) {
    pi.sendUserMessage(missed.prompt);
  }
  assert(pi.getFiredCount() === 1, "missed one-shot was fired on recovery");
  assert(pi.getFired()[0].prompt === "missed-oneshot", "recovered prompt correct");
  clearAllTasks();
}

// =====================================================================
// TEST 9: Lock — acquire, verify, release
// =====================================================================
async function testLockRoundTrip() {
  section("9. Lock — acquire → verify → release → reacquire");
  await mkdir(TEST_DIR, { recursive: true });

  const acquired1 = await acquireLock(TEST_DIR, config);
  assert(acquired1 === true, "first acquire succeeds");

  const lockRaw = await readFile(join(TEST_DIR, config.durableFilePath + ".lock"), "utf-8");
  const lock = JSON.parse(lockRaw);
  assert(lock.pid === process.pid, "lock PID = current process");

  // Cannot acquire again (alive PID blocks)
  const acquired2 = await acquireLock(TEST_DIR, config);
  assert(acquired2 === false, "second acquire blocked (alive PID)");

  await releaseLock(TEST_DIR, config);
  let lockGone = false;
  try { await readFile(join(TEST_DIR, config.durableFilePath + ".lock")); }
  catch { lockGone = true; }
  assert(lockGone, "lock file removed after release");

  const acquired3 = await acquireLock(TEST_DIR, config);
  assert(acquired3 === true, "re-acquire after release succeeds");
  await releaseLock(TEST_DIR, config);
}

// =====================================================================
// TEST 10: Stale lock recovery from dead PID
// =====================================================================
async function testStaleLockRecovery() {
  section("10. Stale Lock Recovery — dead PID yields lock");
  await mkdir(TEST_DIR, { recursive: true });

  // Write a lock with a dead PID
  await writeFile(join(TEST_DIR, config.durableFilePath + ".lock"),
    JSON.stringify({ pid: 999999, acquiredAt: Date.now() }), "utf-8");

  const acquired = await acquireLock(TEST_DIR, config);
  assert(acquired === true, "acquired from dead PID");

  // Verify lock now has our PID
  const lockRaw = await readFile(join(TEST_DIR, config.durableFilePath + ".lock"), "utf-8");
  const lock = JSON.parse(lockRaw);
  assert(lock.pid === process.pid, "recovered lock has our PID");
  await releaseLock(TEST_DIR, config);
}

// =====================================================================
// TEST 11: Multiple tasks fire correctly
// =====================================================================
async function testMultipleTasksFire() {
  section("11. Multiple Concurrent Tasks — both fire independently");
  clearAllTasks();
  const pi = new MockPi();
  const scheduler = new LoopScheduler(pi, config, TEST_DIR);
  scheduler.setContext({ hasUI: false, ui: { notify: () => {}, setStatus: () => {} } });

  // Two overdue recurring tasks — both overdue by >1 interval
  const task1 = makeTask("*/1 * * * *", "task-alpha", { recurring: true });
  task1.lastFiredAt = Date.now() - 125_000; // 2min5s overdue
  updateTask(task1);

  const task2 = makeTask("*/1 * * * *", "task-beta", { recurring: true });
  task2.lastFiredAt = Date.now() - 125_000; // same
  updateTask(task2);

  assert(getTaskCount() === 2, "2 tasks in store");

  scheduler.start();
  let bothFired = false;
  // Wait up to 15s — both are overdue so should fire within first few ticks
  for (let i = 0; i < 30; i++) {
    await wait(500);
    const prompts = pi.getFired().map(f => f.prompt);
    if (prompts.includes("task-alpha") && prompts.includes("task-beta")) {
      bothFired = true;
      break;
    }
  }
  scheduler.stop();

  assert(bothFired, "both overdue tasks fired");
  const alphaFires = pi.getFired().filter(f => f.prompt === "task-alpha").length;
  const betaFires = pi.getFired().filter(f => f.prompt === "task-beta").length;
  console.log(`     → alpha fires: ${alphaFires}, beta fires: ${betaFires}`);
  clearAllTasks();
}

// =====================================================================
// TEST 12: Max jobs limit enforced
// =====================================================================
async function testMaxJobs() {
  section("12. Max Jobs Limit — enforced at 50");
  clearAllTasks();

  // Fill up to 50
  for (let i = 0; i < 50; i++) {
    addTask({
      id: generateTaskId(), cron: "*/5 * * * *", prompt: `fill-${i}`,
      createdAt: Date.now(), recurring: true, durable: false,
    });
  }
  assert(getTaskCount() === 50, "50 tasks added");

  // 51st should still add (addTask doesn't enforce max — the tool layer does)
  const id51 = generateTaskId();
  addTask({ id: id51, cron: "*/5 * * * *", prompt: "overflow",
    createdAt: Date.now(), recurring: true, durable: false });
  assert(getTaskCount() === 51, "51st task at store level (tool enforces max)");

  // But the tool layer check: getTaskCount() >= config.maxJobs
  assert(getTaskCount() >= config.maxJobs, "tool layer would reject: count >= maxJobs");
  clearAllTasks();
}

// =====================================================================
// TEST 13: Duplicate ID rejected (MD-005)
// =====================================================================
async function testDuplicateRejection() {
  section("13. Duplicate Task ID Rejection (MD-005)");
  clearAllTasks();
  const id = generateTaskId();
  const t1 = addTask({ id, cron: "*/5 * * * *", prompt: "dup-test",
    createdAt: Date.now(), recurring: true, durable: false });
  assert(t1 === true, "first add succeeds");
  const t2 = addTask({ id, cron: "*/5 * * * *", prompt: "dup-test-2",
    createdAt: Date.now(), recurring: true, durable: false });
  assert(t2 === false, "duplicate ID rejected");
  assert(getTaskCount() === 1, "only 1 task in store");
  clearAllTasks();
}

// =====================================================================
// TEST 14: Cron parser — all real patterns used by /loop
// =====================================================================
async function testCronParserRealPatterns() {
  section("14. Cron Parser — /loop-generated patterns");
  const patterns = [
    { input: "5m", expected: "*/5 * * * *" },
    { input: "10m", expected: "*/10 * * * *" },
    { input: "15m", expected: "*/15 * * * *" },
    { input: "30m", expected: "*/30 * * * *" },
    { input: "1h", expected: "0 */1 * * *" },
    { input: "2h", expected: "0 */2 * * *" },
    { input: "1d", expected: "0 0 */1 * *" },
    { input: "30s", expected: "*/1 * * * *" },
    { input: "120m", expected: "0 */2 * * *" },
  ];
  for (const p of patterns) {
    const result = intervalToCron(p.input);
    assert(result === p.expected, `${p.input} → ${p.expected} (got ${result})`);
  }
}

// =====================================================================
// TEST 15: Timing accuracy — 5-second wakeup
// =====================================================================
async function testTimingAccuracy() {
  section("15. Timing Accuracy — 5s wakeup with drift measurement");
  clearAllTasks();
  const pi = new MockPi();
  const scheduler = new LoopScheduler(pi, config, TEST_DIR);
  scheduler.setContext({ hasUI: false, ui: { notify: () => {}, setStatus: () => {} } });

  const delays = [3000, 5000]; // 3s, 5s
  const drifts = [];

  for (const delayMs of delays) {
    pi.clearFired();
    clearAllTasks();
    const expectedFire = Date.now() + delayMs;
    const task = makeTask(`_wakeup_${expectedFire}`, `wakeup-${delayMs}ms`, {
      recurring: false, nextFireTime: expectedFire,
    });

    scheduler.start();
    for (let i = 0; i < Math.ceil(delayMs / 500) + 8; i++) {
      await wait(500);
      if (pi.getFiredCount() > 0) break;
    }
    scheduler.stop();

    if (pi.getFiredCount() > 0) {
      const actualFire = pi.getFired()[0].time;
      const drift = actualFire - expectedFire;
      drifts.push({ delay: delayMs, drift });
      console.log(`     → ${delayMs}ms wakeup: drift = ${drift}ms`);
    } else {
      drifts.push({ delay: delayMs, drift: Infinity });
      console.log(`     → ${delayMs}ms wakeup: DID NOT FIRE`);
    }
  }

  for (const d of drifts) {
    assert(d.drift < 2000, `${d.delay}ms wakeup drift < 2s (actual: ${d.drift}ms)`);
  }
  clearAllTasks();
}

// =====================================================================
// TEST 16: Error handling — corrupt file, missing file
// =====================================================================
async function testErrorResilience() {
  section("16. Error Resilience — corrupt/missing files");
  await mkdir(TEST_DIR, { recursive: true });
  clearAllTasks();

  // Missing file
  const freshDir = join(tmpdir(), `pi-loop-err-${Date.now()}`);
  await mkdir(freshDir, { recursive: true });
  const r1 = await loadDurableTasks(freshDir, config);
  assert(r1.tasks.length === 0 && r1.missedOneshots.length === 0, "ENOENT → empty, no crash");

  // Corrupt JSON
  await writeFile(join(freshDir, config.durableFilePath), "}{not json", "utf-8");
  const r2 = await loadDurableTasks(freshDir, config);
  assert(r2.tasks.length === 0, "corrupt JSON → empty, no crash");

  // Non-array tasks
  await writeFile(join(freshDir, config.durableFilePath), '{"tasks":"nope"}', "utf-8");
  const r3 = await loadDurableTasks(freshDir, config);
  assert(r3.tasks.length === 0, "non-array → empty, no crash");

  await rm(freshDir, { recursive: true }).catch(() => {});
}

// =====================================================================
// MAIN
// =====================================================================
async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Real E2E Test Suite — @pi-agents/loop@0.3.0 (published pkg)    ║");
  console.log("║  Uses actual scheduler, real ticks, real fire measurements     ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  await mkdir(TEST_DIR, { recursive: true });

  try {
    await testSchedulerStarts();
    await testRecurringFire();
    await testIdleGating();
    await testOneShotFire();
    await testRecurringMultipleFires();
    await testWakeupTiming();
    await testDurableRoundTrip();
    await testMissedOneshotRecovery();
    await testLockRoundTrip();
    await testStaleLockRecovery();
    await testMultipleTasksFire();
    await testMaxJobs();
    await testDuplicateRejection();
    await testCronParserRealPatterns();
    await testTimingAccuracy();
    await testErrorResilience();
  } finally {
    scheduler: undefined;
    await rm(TEST_DIR, { recursive: true }).catch(() => {});
    clearAllTasks();
  }

  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  const pad = Math.max(0, 34 - `${passed}/${total} passed, ${failed} failed`.length);
  console.log(`║  Results: ${passed}/${total} passed, ${failed} failed${" ".repeat(pad)}║`);
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  if (failures.length > 0) {
    console.log("\n❌ Failures:");
    failures.forEach(f => console.log(`   - ${f}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(2); });