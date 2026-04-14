# Pi-Coding-Agent Extension API

> Analysis of the pi-coding-agent extension system from [badlogic/pi-mono](https://github.com/badlogic/pi-mono). This documents the API surface that a `/loop`-like extension would use.

**Source**: `packages/coding-agent/src/core/extensions/`

---

## Extension System Overview

Extensions are TypeScript modules that can:
- Subscribe to agent lifecycle events
- Register LLM-callable tools
- Register slash commands, keyboard shortcuts, and CLI flags
- Interact with the user via UI primitives
- Send messages to the agent programmatically
- Register custom model providers

An extension is a module that exports a **default factory function**:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  // Registration logic here
}
```

---

## Discovery & Loading

**File**: `loader.ts`

Extensions are discovered from three locations (in order):

1. **Global**: `<agentDir>/extensions/` (e.g., `~/.pi/agent/extensions/`)
2. **Project-local**: `<cwd>/.pi/extensions/`
3. **Explicitly configured paths**

Discovery rules per directory:
- `.ts` or `.js` files directly in the directory → load
- Subdirectories with `index.ts`/`index.js` → load the index
- Subdirectories with `package.json` containing a `"pi"` field → load declared extensions

### package.json Manifest

```json
{
  "pi": {
    "extensions": ["src/loop.ts"],
    "themes": [],
    "skills": [],
    "prompts": []
  }
}
```

Extensions are loaded via `@mariozechner/jiti` (fork with virtualModules support for compiled Bun binaries), which allows TypeScript imports without pre-compilation.

### Virtual Modules

When running as a compiled Bun binary, these packages are available to extensions via virtual module injection:

| Package | Purpose |
|---------|---------|
| `@sinclair/typebox` | Schema definitions for tool parameters |
| `@mariozechner/pi-agent-core` | Agent runtime (tool calling, state) |
| `@mariozechner/pi-tui` | Terminal UI components |
| `@mariozechner/pi-ai` | Multi-provider LLM API |
| `@mariozechner/pi-coding-agent` | Full coding agent API |

---

## ExtensionAPI Surface

**File**: `types.ts` (lines 859-1036+)

The `ExtensionAPI` interface provides these capabilities:

### Event Subscription

```typescript
pi.on(event: string, handler: ExtensionHandler): void
```

Available events:

| Event | Type | Can Modify? |
|-------|------|-------------|
| `resources_discover` | `ResourcesDiscoverEvent` | Yes → return `skillPaths`, `promptPaths`, `themePaths` |
| `session_start` | `SessionStartEvent` | No |
| `session_before_switch` | `SessionBeforeSwitchEvent` | Yes → return `{ cancel: true }` |
| `session_switch` | `SessionSwitchEvent` | No |
| `session_before_fork` | `SessionBeforeForkEvent` | Yes → return `{ cancel: true }` |
| `session_fork` | `SessionForkEvent` | No |
| `session_before_compact` | `SessionBeforeCompactEvent` | Yes → return `{ cancel: true }` or `{ compaction }` |
| `session_compact` | `SessionCompactEvent` | No |
| `session_shutdown` | `SessionShutdownEvent` | No |
| `session_before_tree` | `SessionBeforeTreeEvent` | Yes → return `{ cancel: true }` or provide summary |
| `session_tree` | `SessionTreeEvent` | No |
| `context` | `ContextEvent` | Yes → return `{ messages }` to modify context |
| `before_agent_start` | `BeforeAgentStartEvent` | Yes → return `{ message }` or `{ systemPrompt }` |
| `agent_start` | `AgentStartEvent` | No |
| `agent_end` | `AgentEndEvent` | No |
| `turn_start` | `TurnStartEvent` | No |
| `turn_end` | `TurnEndEvent` | No |
| `model_select` | `ModelSelectEvent` | No |
| `tool_call` | `ToolCallEvent` | Yes → return `{ block: true, reason }` to block |
| `tool_result` | `ToolResultEvent` | Yes → return `{ content, details }` to modify |
| `user_bash` | `UserBashEvent` | Yes → return `{ operations }` or `{ result }` |
| `input` | `InputEvent` | Yes → return `{ action: "transform", text }` or `{ action: "handled" }` |

### Tool Registration

```typescript
pi.registerTool<TParams, TDetails>(tool: ToolDefinition<TParams, TDetails>): void
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
  renderCall?: (args, theme) => Component;     // Custom call rendering
  renderResult?: (result, options, theme) => Component; // Custom result rendering
}
```

### Command Registration

```typescript
pi.registerCommand(name: string, options: {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}): void
```

### Message Sending

```typescript
// Send a custom message (optionally triggers an agent turn)
pi.sendMessage(message: Pick<CustomMessage, "customType" | "content" | "display" | "details">, options?: {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}): void

// Send a user message (always triggers a turn)
pi.sendUserMessage(content: string | (TextContent | ImageContent)[], options?: {
  deliverAs?: "steer" | "followUp";
}): void
```

### Other Actions

```typescript
pi.appendEntry(customType: string, data?: unknown): void  // Persist state (not sent to LLM)
pi.setSessionName(name: string): void
pi.getSessionName(): string | undefined
pi.setLabel(entryId: string, label: string | undefined): void
pi.exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>
pi.getActiveTools(): string[]
pi.getAllTools(): ToolInfo[]
pi.setActiveTools(toolNames: string[]): void
pi.getCommands(): SlashCommandInfo[]
pi.setModel(model: Model<any>): Promise<boolean>
pi.getThinkingLevel(): ThinkingLevel
pi.setThinkingLevel(level: ThinkingLevel): void
pi.registerProvider(name: string, config: ProviderConfig): void
pi.getFlag(name: string): boolean | string | undefined
```

### Event Bus

```typescript
pi.events: EventBus  // Shared event bus for inter-extension communication
```

---

## ExtensionContext

Passed to event handlers and command handlers:

```typescript
interface ExtensionContext {
  ui: ExtensionUIContext;           // UI methods
  hasUI: boolean;                    // false in print/RPC mode
  cwd: string;                       // Current working directory
  sessionManager: ReadonlySessionManager;
  modelRegistry: ModelRegistry;
  model: Model<any> | undefined;
  isIdle(): boolean;                 // Whether agent is not streaming
  abort(): void;                     // Abort current agent operation
  hasPendingMessages(): boolean;
  shutdown(): void;
  getContextUsage(): ContextUsage | undefined;
  compact(options?: CompactOptions): void;
  getSystemPrompt(): string;
}
```

### ExtensionCommandContext (extends ExtensionContext)

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

### ExtensionUIContext

```typescript
interface ExtensionUIContext {
  select(title: string, options: string[], opts?): Promise<string | undefined>;
  confirm(title: string, message: string, opts?): Promise<boolean>;
  input(title: string, placeholder?: string, opts?): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;
  setWidget(key: string, content: string[] | Component, options?): void;
  setFooter(factory?): void;
  setHeader(factory?): void;
  setTitle(title: string): void;
  custom<T>(factory, options?): Promise<T>;
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  setEditorComponent(factory?): void;
  theme: Theme;
  getAllThemes(): { name: string; path: string | undefined }[];
  getTheme(name: string): Theme | undefined;
  setTheme(theme: string | Theme): { success: boolean; error?: string };
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}
```

---

## ExtensionRuntime

Internal runtime object shared across extensions. Not exposed to extension authors directly, but its methods are delegated through `ExtensionAPI`:

```typescript
interface ExtensionRuntime {
  sendMessage: (message, options?) => void;
  sendUserMessage: (content, options?) => void;
  appendEntry: (customType, data?) => void;
  setSessionName: (name) => void;
  getSessionName: () => string | undefined;
  setLabel: (entryId, label?) => void;
  getActiveTools: () => string[];
  getAllTools: () => ToolInfo[];
  setActiveTools: (toolNames) => void;
  getCommands: () => SlashCommandInfo[];
  setModel: (model) => Promise<boolean>;
  getThinkingLevel: () => ThinkingLevel;
  setThinkingLevel: (level) => void;
  flagValues: Map<string, boolean | string>;
  pendingProviderRegistrations: ProviderRegistration[];
}
```

---

## Tool Wrapper (Interceptor Pattern)

**File**: `wrapper.ts`

Extensions can intercept tool calls and results via `tool_call` and `tool_result` events:

- `tool_call` handler can block execution by returning `{ block: true, reason: "..." }`
- `tool_result` handler can modify the result by returning `{ content, details }`

The wrapper pattern:
```typescript
wrapToolsWithExtensions(tools, runner)
// For each tool:
//   1. Emit tool_call event → check for block
//   2. Execute actual tool
//   3. Emit tool_result event → allow modification
```

---

## Key Differences from Claude Code's Extension System

| Aspect | Claude Code | Pi-Coding-Agent |
|--------|------------|-----------------|
| Extension type | Skills (prompt-based) + tools (native) | Factory function receiving `ExtensionAPI` |
| Registration | `registerBundledSkill()` | `export default function(pi: ExtensionAPI)` |
| Tool definition | Zod schemas | TypeBox schemas |
| Tool execution context | System prompt + model invocation | Direct `execute()` function |
| Event system | React hooks + message queue | `pi.on(event, handler)` |
| Commands | Slash commands via skill | `pi.registerCommand(name, options)` |
| Message sending | `enqueuePendingNotification()` | `pi.sendUserMessage()` / `pi.sendMessage()` |
| State persistence | `.claude/scheduled_tasks.json` | `pi.appendEntry(customType, data)` |
| UI | Terminal (Ink React) | Terminal (TUI components) |
| Scheduling | Built-in CronCreate/CronDelete/CronList tools | **Not built-in** — this is what pi-loop adds |

---

## What a Loop Extension Needs

To implement `/loop`-like functionality as a pi extension, we need:

1. **A `/loop` command** → `pi.registerCommand("loop", {...})`
2. **CronCreate/CronDelete/CronList tools** → `pi.registerTool(...)` for each
3. **A scheduler daemon** → JavaScript `setInterval` running within the extension
4. **State persistence** → `pi.appendEntry("loop-task", data)` for session state
5. **Message injection on fire** → `pi.sendUserMessage(prompt)` when a task fires
6. **UI notifications** → `ctx.ui.notify()`, `ctx.ui.setStatus()` for status
7. **Lifecycle hooks** → `pi.on("session_start")` to restore tasks, `pi.on("session_shutdown")` for cleanup
8. **Idle detection** → `ctx.isIdle()` to avoid interrupting in-progress turns

The key architectural difference: Claude Code uses a dedicated scheduler with file locking and chokidar file watching for durable persistence. A pi extension runs inside the agent process and can use Node.js timers directly, but needs `pi.appendEntry()` for cross-session persistence since the extension dies when the process exits.