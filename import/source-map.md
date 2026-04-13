# Claude Code Source Map

> Structural analysis of the Claude Code source implementation that `/loop` and the scheduling system depend on. No direct code — just maps of modules, files, and their relationships.

**Source root**: `source/claude-code/src/`

---

## Scheduling/Cron System (Core for pi-loop)

These are the files that directly implement `/loop` and the cron scheduling pipeline:

| Module | Path | Size | Purpose |
|--------|------|------|---------|
| Loop Skill | `skills/bundled/loop.ts` | 4.7KB | `/loop` command entry point — parses arguments, invokes CronCreate |
| CronCreate Tool | `tools/ScheduleCronTool/CronCreateTool.ts` | ~6KB | Creates cron jobs; validates cron expressions; max 50 jobs; routes to session or disk storage |
| CronDelete Tool | `tools/ScheduleCronTool/CronDeleteTool.ts` | ~3KB | Cancels cron jobs by ID from session store or `.claude/scheduled_tasks.json` |
| CronList Tool | `tools/ScheduleCronTool/CronListTool.ts` | ~2KB | Lists all active cron jobs (session + file-backed) |
| Cron Prompt | `tools/ScheduleCronTool/prompt.ts` | ~4.4KB | System prompt builders for CronCreate/CronDelete/CronList; feature gates (`isKairosCronEnabled`, `isDurableCronEnabled`); `DEFAULT_MAX_AGE_DAYS` |
| Cron UI | `tools/ScheduleCronTool/UI.tsx` | ~5KB | React rendering for cron tool messages (scheduled, fired, deleted) |
| Cron Engine | `utils/cron.ts` | 9.5KB | 5-field cron parser, next-run calculator (`computeNextCronRun`), human-readable formatter (`cronToHuman`) |
| Cron Task Store | `utils/cronTasks.ts` | 17KB | `CronTask` type, CRUD operations (`addCronTask`, `removeCronTask`, `readCronTasks`, `writeCronTasks`), jitter logic (`jitteredNextCronRunMs`, `oneShotJitteredNextCronRunMs`), missed-task detection (`findMissedTasks`), `CronJitterConfig` type + defaults |
| Cron Scheduler | `utils/cronScheduler.ts` | 21KB | The scheduler daemon: 1s check loop, file watcher (chokidar), lock coordination, fire routing, missed-task handling, startup/teardown lifecycle |
| Cron Lock | `utils/cronTasksLock.ts` | 6KB | O_EXCL-based `.claude/scheduled_tasks.lock` for multi-session coordination |
| Cron Jitter Config | `utils/cronJitterConfig.ts` | 3.4KB | GrowthBook-backed runtime config for jitter parameters (`tengu_kairos_cron_config`) |
| Scheduled Tasks Hook | `hooks/useScheduledTasks.ts` | ~5KB | React hook wiring the scheduler into the REPL; routes fires to lead or teammate queues |
| Bootstrap State | `bootstrap/state.ts` | 56KB | Global state store; includes `sessionCronTasks`, `scheduledTasksEnabled`, `getSessionCronTasks()`, `addSessionCronTask()`, `removeSessionCronTasks()` |
| Schedule Remote Agents | `skills/bundled/scheduleRemoteAgents.ts` | 19KB | Remote agent scheduling skill (CronCreate-driven triggers) |

### Data Flow

```
User types /loop 5m check the deploy
        │
        ▼
  loop.ts: registerLoopSkill()
        │  Parses args → builds prompt for model
        ▼
  Model calls CronCreate tool
        │
        ▼
  CronCreateTool.call()
        │  Validates cron, creates CronTask
        │  Routes: durable? → file (.claude/scheduled_tasks.json)
        │           session? → STATE.sessionCronTasks
        │  Sets scheduledTasksEnabled = true
        ▼
  useScheduledTasks hook (mounts scheduler)
        │
        ▼
  createCronScheduler({onFire, onFireTask, isLoading, ...})
        │  Acquires scheduler lock (O_EXCL)
        │  Watches .claude/scheduled_tasks.json (chokidar)
        │  Starts 1s check loop
        ▼
  Every 1s: check()
        │  Is killed? → skip
        │  Is loading? → defer (unless assistant mode)
        │  For each task: now >= nextFireAt? → fire
        ▼
  Fire routing (useScheduledTasks)
        │  task.agentId? → injectUserMessageToTeammate()
        │  Otherwise   → enqueuePendingNotification() at 'later' priority
        ▼
  REPL command queue drains the prompt
        between turns → executed as normal user input
```

---

## Broader Source Structure

### Top-Level Directory Map

| Directory | Purpose |
|-----------|---------|
| `assistant/` | Session history management |
| `bootstrap/` | App bootstrap + global state (`state.ts` = 56KB Zustand store) |
| `bridge/` | Remote/local bridge for IDE/browser connections (REPL-bridge architecture) |
| `buddy/` | Companion sprite UI (animated terminal buddy) |
| `cli/` | CLI/headless mode: `print.ts`, `structuredIO.ts`, CLI handlers + transports |
| `commands/` | 80+ slash command implementations (each subdir = `/command`) |
| `components/` | 80+ React UI components for terminal interface |
| `constants/` | Shared constants |
| `context/` | React context providers |
| `coordinator/` | Multi-agent/swarm coordination (`coordinatorMode.ts`) |
| `entrypoints/` | App entry points: `cli.tsx`, `init.ts`, `mcp.ts`, `sdk/` |
| `hooks/` | 80+ React hooks — the nerve center of the interactive UI |
| `ink/` | Ink framework customization for terminal React |
| `keybindings/` | Keybinding system (vim-like + custom shortcuts) |
| `memdir/` | Memory directory management (`.claude/` memory files) |
| `migrations/` | Settings/data migration scripts |
| `moreright/` | Extended display/alignment utilities |
| `native-ts/` | Native module TypeScript wrappers |
| `outputStyles/` | Output style definitions |
| `plugins/` | Plugin system |
| `query/` | Query engine: transitions, budget, config, stop hooks |
| `remote/` | Remote session management (WebSocket, SDK message adapter) |
| `screens/` | Full-screen UI views (`REPL.tsx`, `Doctor.tsx`) |
| `server/` | Server-side session management (direct connect) |
| `services/` | Core business logic (API, analytics, LSP, MCP, OAuth, voice, etc.) |
| `skills/` | Skill system: bundled implementations + directory loader |
| `state/` | React state management (Zustand: `AppStateStore.ts`) |
| `tasks/` | Task management system |
| `tools/` | 30+ tool implementations (each subdir = one tool) |
| `types/` | TypeScript type definitions |
| `utils/` | 250+ utility functions (largest flat directory) |
| `vim/` | Vim mode motions/operators/text objects |
| `voice/` | Voice mode flag |

### Key Top-Level Files

| File | Purpose |
|------|---------|
| `main.tsx` | App entry point (804KB — largest file) |
| `Tool.ts` | Tool base abstraction |
| `Task.ts` | Task data model |
| `tools.ts` | Tool registry |
| `QueryEngine.ts` | Query engine core |
| `commands.ts` | Slash command registry |
| `history.ts` | Conversation history management |

### Skills System (`skills/`)

| File | Purpose |
|------|---------|
| `bundled/loop.ts` | **`/loop` skill** — the one we're analyzing |
| `bundled/scheduleRemoteAgents.ts` | Remote agent scheduling (CronCreate-driven) |
| `bundled/batch.ts` | Batch processing skill |
| `bundled/simplify.ts` | Code review/simplification |
| `bundled/skillify.ts` | Skill creation |
| `bundled/updateConfig.ts` | Config updates |
| `bundled/remember.ts` | Memory/CLAUDE.md |
| `bundled/keybindings.ts` | Keybinding config |
| `bundled/stuck.ts` | Stuck/conversation recovery |
| `bundled/claudeApi.ts` | Claude API skill |
| `bundled/index.ts` | Skill index/exports |
| `bundledSkills.ts` | Bundled skill registry |
| `loadSkillsDir.ts` | Skill directory loader |

### Tools (`tools/`)

Each subdirectory is a tool Claude can invoke. Key ones:

| Tool | Purpose |
|------|---------|
| `ScheduleCronTool/` | **Cron scheduling** (CronCreate, CronDelete, CronList) |
| `BashTool/` | Shell command execution |
| `AgentTool/` | Agent spawning |
| `FileReadTool/` | File reading |
| `FileEditTool/` | File editing |
| `FileWriteTool/` | File writing |
| `GlobTool/` | File globbing |
| `GrepTool/` | Content searching |
| `WebFetchTool/` | Web fetching |
| `WebSearchTool/` | Web searching |
| `MCPTool/` | MCP tool invocation |
| `TaskCreateTool/` / `TaskUpdateTool/` | Task list CRUD |
| `EnterWorktreeTool/` / `ExitWorktreeTool/` | Worktree management |
| `SendMessageTool/` | Team messaging |
| `RemoteTriggerTool/` | Remote agent triggers |
| `SkillTool/` | Skill invocation |

### Hooks (`hooks/`)

Key hooks beyond the scheduling one:

| Hook | Purpose |
|------|---------|
| **`useScheduledTasks.ts`** | Cron scheduler mounting & fire routing |
| `useMainLoopModel.ts` | Main conversation loop model |
| `useCommandQueue.ts` | Command queue processing |
| `useInputBuffer.ts` | Input buffer management |
| `useMergedTools.ts` | Tool merging |
| `useMergedCommands.ts` | Command merging |
| `useTasksV2.ts` | Task list v2 |
| `useSettings.ts` | Settings access |

### Services (`services/`)

| Subdir | Purpose |
|--------|---------|
| `api/` | Anthropic API client |
| `analytics/` | Telemetry + GrowthBook feature flags |
| `autoDream/` | Auto-dream (background planning) |
| `compact/` | Conversation compaction |
| `lsp/` | Language Server Protocol |
| `mcp/` | MCP server management |
| `MagicDocs/` | Magic Docs service |
| `plugins/` | Plugin service |
| `oauth/` | OAuth authentication |
| `PromptSuggestion/` | Prompt suggestion engine |
| `SessionMemory/` | Session memory |
| `settingsSync/` | Settings sync |
| `teamMemorySync/` | Team memory sync |

### Utils — Cron-Related (`utils/cron*.ts`)

| File | Responsibility |
|------|----------------|
| `cron.ts` | Parse 5-field cron expressions, compute next-run times, format as human-readable |
| `cronScheduler.ts` | The scheduler daemon: 1s timer, chokidar file watcher, lock acquisition, fire dispatch, missed-task surfacing |
| `cronTasks.ts` | `CronTask` type, CRUD to `.claude/scheduled_tasks.json`, session store, jitter calculation, `CronJitterConfig` defaults |
| `cronTasksLock.ts` | O_EXCL-based `.claude/scheduled_tasks.lock` for multi-session safety |
| `cronJitterConfig.ts` | GrowthBook runtime config loader for jitter parameters |

### Utils — Other Key Files

| File | Responsibility |
|------|----------------|
| `systemPrompt.ts` | System prompt construction |
| `messages.ts` | Message utilities |
| `messageQueueManager.ts` | Message queue (used by cron fire routing) |
| `workloadContext.ts` | Workload attribution (`WORKLOAD_CRON` etc.) |
| `debug.ts` | Debug logging |
| `envUtils.ts` | Environment variable utilities |
| `fsOperations.ts` | Filesystem operations abstraction |
| `json.ts` | Safe JSON parsing |
| `teammateContext.ts` | Teammate context routing |