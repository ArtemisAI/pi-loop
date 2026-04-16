# Pi-Coding-Agent Extension API

> Analysis of the pi-coding-agent extension system from [badlogic/pi-mono](https://github.com/badlogic/pi-mono).
>
> **Last updated**: 2026-04-16 — revised after deep-dive against pi-mono source (`packages/coding-agent/src/core/extensions/types.ts`).

**Source**: `packages/coding-agent/src/core/extensions/`
**Package**: `@mariozechner/pi-coding-agent`

---

## Extension System Overview

Extensions are TypeScript modules that export a **default factory function**:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // Registration logic here
}
```

Extensions can:
- Subscribe to agent lifecycle events (20+ events)
- Register LLM-callable tools (TypeBox schemas + execute handlers)
- Register slash commands, keyboard shortcuts, and CLI flags
- Interact with the user via UI primitives
- Send messages to the agent programmatically
- Register custom model providers
- Communicate with other extensions via EventBus

---

## Discovery & Loading

Extensions are discovered from:

1. **Global**: `~/.pi/agent/extensions/` (single files or subdirectory indices)
2. **Project-local**: `.pi/extensions/`
3. **npm packages**: `"npm:@scope/package@version"` in settings.json `packages` array
4. **Git repos**: `"git:github.com/user/repo"`

### package.json Manifest

```json
{
  "name": "my-extension",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/index.ts"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
  }
}
```

---

## ExtensionAPI Surface

### Event Subscription

```typescript
pi.on(event: string, handler: ExtensionHandler): void
```

#### Complete Event List

| Event | Can Modify? | Purpose |
|---|---|---|
| `resources_discover` | Yes | Return additional paths |
| `session_start` | No | Session initialization |
| `session_before_switch` | Yes (cancel) | Before session switch |
| `session_switch` | No | After session switch |
| `session_before_fork` | Yes (cancel) | Before session fork |
| `session_fork` | No | After session fork |
| `session_before_compact` | Yes (cancel/custom) | Before compaction |
| `session_compact` | No | After compaction |
| `session_shutdown` | No | Session teardown |
| `session_before_tree` | Yes (cancel/custom) | Before tree navigation |
| `session_tree` | No | After tree navigation |
| `context` | Yes (modify messages) | Context injection |
| `before_agent_start` | Yes (inject message) | Before agent starts |
| `agent_start` | No | Agent processing started |
| `agent_end` | No | Agent processing ended |
| `turn_start` | No | Turn started |
| `turn_end` | No | Turn ended |
| `message_start` | No | Message streaming started |
| `message_update` | No | Message streaming update |
| `message_end` | No | Message streaming ended |
| `tool_execution_start` | No | Tool execution started |
| `tool_execution_update` | No | Tool execution update |
| `tool_execution_end` | No | Tool execution ended |
| `model_select` | No | Model changed |
| `tool_call` | Yes (block) | Intercept tool calls |
| `tool_result` | Yes (modify) | Modify tool results |
| `user_bash` | Yes (custom ops) | Intercept bash commands |
| `input` | Yes (transform/handle) | Transform user input |

### Tool Registration

```typescript
pi.registerTool<TParams, TDetails>(tool: ToolDefinition): void
```

**ToolDefinition**:

```typescript
interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string;                    // Tool name (used in LLM tool calls)
  label: string;                  // Human-readable label for UI
  description: string;            // Description for LLM
  parameters: TParams;            // TypeBox schema for parameters
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
  renderCall?: (args, theme) => Component;
  renderResult?: (result, options, theme) => Component;
}
```

**Important**: Use `StringEnum` from `@mariozechner/pi-ai` for string enums (not `Type.Union`/`Type.Literal`, which breaks Google API compatibility).

### Command Registration

```typescript
pi.registerCommand(name: string, options: {
  description?: string;
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}): void
```

### Message Sending

```typescript
// Send as user message (triggers full agent turn)
pi.sendUserMessage(content: string | Content[], options?: {
  deliverAs?: "steer" | "followUp";
}): void

// Send custom message
pi.sendMessage(message: CustomMessage, options?: {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}): void
```

### Other API Methods

```typescript
pi.appendEntry(customType: string, data?: T): void  // Persist state
pi.setSessionName(name: string): void
pi.getSessionName(): string | undefined
pi.exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>
pi.getActiveTools(): string[]
pi.getAllTools(): ToolInfo[]
pi.setActiveTools(toolNames: string[]): void
pi.getCommands(): SlashCommandInfo[]
pi.setModel(model: Model): Promise<boolean>
pi.getThinkingLevel(): ThinkingLevel
pi.setThinkingLevel(level: ThinkingLevel): void
pi.registerProvider(name: string, config: ProviderConfig): void
pi.registerShortcut(shortcut: KeyId, options: ShortcutOptions): void
pi.registerFlag(name: string, options: FlagOptions): void
pi.getFlag(name: string): boolean | string | undefined
pi.events: EventBus  // Inter-extension communication
```

---

## ExtensionContext

### Base Context (all handlers)

```typescript
interface ExtensionContext {
  ui: ExtensionUIContext;
  hasUI: boolean;                    // false in print/RPC mode
  cwd: string;
  sessionManager: ReadonlySessionManager;
  modelRegistry: ModelRegistry;
  model: Model | undefined;
  isIdle(): boolean;
  abort(): void;
  hasPendingMessages(): boolean;
  shutdown(): void;
  getContextUsage(): ContextUsage | undefined;
  compact(options?: CompactOptions): void;
  getSystemPrompt(): string;
}
```

### Command Context (extends base)

```typescript
interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
  newSession(options?): Promise<{ cancelled: boolean }>;
  fork(entryId: string): Promise<{ cancelled: boolean }>;
  navigateTree(targetId: string, options?): Promise<{ cancelled: boolean }>;
  switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
  reload(): Promise<void>;
}
```

### UI Context

```typescript
interface ExtensionUIContext {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  setWidget(key: string, content: string[] | Component, options?): void;
  setFooter(factory?): void;
  setHeader(factory?): void;
  setTitle(title: string): void;
  theme: Theme;
  // ... more methods
}
```

---

## Key Differences from Claude Code's System

| Aspect | Claude Code | Pi-Coding-Agent |
|---|---|---|
| Extension type | Skills (prompt-based) + native tools | Factory function receiving ExtensionAPI |
| Registration | `registerBundledSkill()` | `export default function(pi)` |
| Tool definition | Zod schemas | TypeBox schemas |
| Tool execution | Model invocation | Direct `execute()` function |
| Event system | React hooks + message queue | `pi.on(event, handler)` |
| Commands | Slash commands via skill | `pi.registerCommand(name, options)` |
| Message sending | `enqueuePendingNotification()` | `pi.sendUserMessage()` |
| State persistence | `.claude/scheduled_tasks.json` | `pi.appendEntry()` or custom files |
| Scheduling | Built-in CronCreate/Delete/List | **Not built-in** — pi-loop adds this |

---

## What pi-loop Uses

| pi-mono API | pi-loop Usage |
|---|---|
| `pi.registerTool(ToolDefinition)` | cron_create, cron_delete, cron_list |
| `pi.registerCommand(name, options)` | /loop, /loop-list, /loop-kill |
| `pi.on("session_start")` | Init scheduler, load durable tasks, acquire lock |
| `pi.on("session_shutdown")` | Stop scheduler, release lock |
| `pi.on("agent_start")` | Set scheduler busy |
| `pi.on("agent_end")` | Set scheduler idle, drain pending fires |
| `pi.sendUserMessage(content)` | Inject prompt when task fires |
| `ctx.ui.notify(message, type)` | Fire notifications |
| `ctx.ui.setStatus(key, text)` | Status bar loop count |
| `ctx.hasUI` | Gate UI calls in print/RPC mode |
| `ctx.cwd` | Project root for durable file paths |

### Not Used (Available for Future Features)

| pi-mono API | Potential pi-loop Use |
|---|---|
| `pi.on("session_before_compact")` | Snapshot session tasks before compaction |
| `pi.on("session_compact")` | Restore session tasks after compaction |
| `pi.on("tool_call")` | Intercept cron tool calls for validation |
| `pi.appendEntry()` | Session-aware state persistence |
| `ctx.ui.setWidget()` | Rich status bar widget |
| `pi.events` | Inter-extension coordination |

---

## Available Packages for Extensions

| Package | Purpose |
|---|---|
| `@mariozechner/pi-coding-agent` | Full extension API, types, truncation utilities |
| `@mariozechner/pi-ai` | StringEnum, model utilities |
| `@mariozechner/pi-agent-core` | AgentToolResult type |
| `@sinclair/typebox` | Schema definitions |
| `@mariozechner/pi-tui` | Terminal UI components |
| Node.js built-ins | fs, path, crypto, etc. |
