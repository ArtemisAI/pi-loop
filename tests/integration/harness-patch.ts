/**
 * Compatibility patch for @marcfargas/pi-test-harness v0.5.0 with
 * @mariozechner/pi-agent-core v0.66.x.
 *
 * The harness calls `session.agent.setTools(tools)` which was removed in
 * pi-agent-core 0.66.0. This patch adds the shim back.
 */

import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";

let patched = false;

export function patchAgentForHarness(): void {
  if (patched) return;

  if (!(Agent.prototype as any).setTools) {
    (Agent.prototype as any).setTools = function (tools: AgentTool[]) {
      this.state.tools = tools;
    };
  }

  if (!(Agent.prototype as any).waitForIdle) {
    (Agent.prototype as any).waitForIdle = async function () {
      // In 0.66.x the run promise resolves when idle — no-op
    };
  }

  patched = true;
}
