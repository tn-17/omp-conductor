import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import conductSkill from "./prompts/SKILL.md" with { type: "text" };
import conductOff from "./prompts/off.md" with { type: "text" };
import taskDescription from "./prompts/task.md" with { type: "text" };
import { resolveLocalModel, runWorker } from "./worker";

const STATE_ENTRY = "conduct-state";
const TOOL = "conduct_task";
const USAGE = "/conduct on | off [cancel] | status | model [provider/id] | cancel";

interface ConductState {
  version: 1;
  enabled: boolean;
  model?: string;
}

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
}

function parseState(data: unknown): ConductState | undefined {
  if (!data || typeof data !== "object") return;
  if (!("version" in data) || data.version !== 1) return;
  if (!("enabled" in data) || typeof data.enabled !== "boolean") return;
  if ("model" in data && data.model !== undefined && typeof data.model !== "string") return;
  return {
    version: 1,
    enabled: data.enabled,
    model: "model" in data && typeof data.model === "string" ? data.model : undefined,
  };
}

export default function conductExtension(pi: ExtensionAPI): void {
  let state: ConductState = { version: 1, enabled: false };
  let hasState = false;
  let running: ActiveRun | undefined;

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "conduct",
      state.enabled ? `Conduct: on${running ? " | worker running" : ""}` : undefined,
    );
  }

  async function syncTool(ctx: ExtensionContext): Promise<void> {
    const active = pi.getActiveTools();
    if (state.enabled && !active.includes(TOOL)) await pi.setActiveTools([...active, TOOL]);
    if (!state.enabled && active.includes(TOOL))
      await pi.setActiveTools(active.filter((name) => name !== TOOL));
    updateStatus(ctx);
  }

  function persist(): void {
    hasState = true;
    pi.appendEntry(STATE_ENTRY, { ...state });
  }

  async function restore(ctx: ExtensionContext): Promise<void> {
    state = { version: 1, enabled: false };
    hasState = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const saved = parseState(entry.data);
      if (saved) {
        state = saved;
        hasState = true;
      }
    }
    await syncTool(ctx);
  }

  async function cancelWorker(): Promise<void> {
    const active = running;
    if (!active) return;
    active.controller.abort();
    await active.done;
  }

  async function selectModel(ctx: ExtensionContext, selector?: string): Promise<boolean> {
    if (running) throw new Error("Cancel or finish the worker before changing its model.");
    let selected = selector;
    if (!selected) {
      const choices = ctx.models.list().flatMap((model) => {
        const id = `${model.provider}/${model.id}`;
        try {
          resolveLocalModel(ctx, id);
          return [id];
        } catch {
          return [];
        }
      });
      if (!choices.length)
        throw new Error(
          "No configured loopback model is available. Configure a local model in OMP, then use /conduct model provider/id.",
        );
      if (!ctx.hasUI)
        throw new Error(
          `Choose an exact model with /conduct model provider/id. Available: ${choices.join(", ")}`,
        );
      selected = await ctx.ui.select("Conduct local worker", choices);
      if (!selected) return false;
    }
    const model = resolveLocalModel(ctx, selected);
    state = { ...state, model: `${model.provider}/${model.id}` };
    persist();
    return true;
  }

  pi.registerCommand("conduct", {
    description: "Coordinate one local implementation worker (shared workspace; no isolation yet)",
    handler: async (args, ctx) => {
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        switch (action) {
          case "status":
            if (rest.length) throw new Error(USAGE);
            ctx.ui.notify(
              `Conduct ${state.enabled ? "on" : "off"}. Worker: ${state.model ?? "not selected"}. ${running ? "Worker running." : "Idle."} Slice 1: direct workspace edits; no isolation or advisor.`,
              "info",
            );
            return;
          case "model":
            if (rest.length > 1) throw new Error(USAGE);
            if (await selectModel(ctx, rest[0]))
              ctx.ui.notify(`Conduct worker: ${state.model}`, "info");
            return;
          case "on":
            if (rest.length) throw new Error(USAGE);
            if (!state.model && !(await selectModel(ctx))) return;
            resolveLocalModel(ctx, state.model!);
            state = { ...state, enabled: true };
            persist();
            await syncTool(ctx);
            ctx.ui.notify(
              "Conduct on. Save your files before dispatch. Workers edit this workspace directly; use disposable work until isolation is added. Nothing is dispatched by enabling the mode.",
              "warning",
            );
            return;
          case "off": {
            if (rest.length > 1 || (rest.length === 1 && rest[0] !== "cancel"))
              throw new Error(USAGE);
            if (running && rest[0] !== "cancel") {
              ctx.ui.notify(
                "Worker still running. Use /conduct off cancel to cancel it and disable the mode, or let it finish first. Existing edits will not be rolled back.",
                "warning",
              );
              return;
            }
            state = { ...state, enabled: false };
            persist();
            await cancelWorker();
            await syncTool(ctx);
            ctx.ui.notify(
              "Conduct off. Earlier context and any worker edits remain; conduct instructions are no longer active.",
              "info",
            );
            return;
          }
          case "cancel":
            if (rest.length) throw new Error(USAGE);
            if (!running) {
              ctx.ui.notify("No conduct worker is running.", "info");
              return;
            }
            await cancelWorker();
            ctx.ui.notify(
              "Worker cancelled. Partial edits remain; inspect the workspace before continuing.",
              "warning",
            );
            return;
          default:
            throw new Error(USAGE);
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_switch", async (_event, ctx) => restore(ctx));
  pi.on("session_branch", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  const blockTransition = (_event: unknown, ctx: ExtensionContext) => {
    if (!running) return;
    ctx.ui.notify(
      "Cancel or finish the conduct worker before switching sessions or branches. Use /conduct cancel.",
      "warning",
    );
    return { cancel: true };
  };
  pi.on("session_before_switch", blockTransition);
  pi.on("session_before_branch", blockTransition);
  pi.on("session_before_tree", blockTransition);
  pi.on("session_shutdown", async () => cancelWorker());
  pi.on("before_agent_start", (event) => {
    if (!hasState) return;
    return { systemPrompt: [...event.systemPrompt, state.enabled ? conductSkill : conductOff] };
  });

  pi.registerTool({
    name: TOOL,
    label: "Conduct worker",
    description: taskDescription,
    defaultInactive: true,
    loadMode: "essential",
    approval: "write",
    parameters: pi.typebox.Type.Object({
      directive: pi.typebox.Type.String({
        minLength: 1,
        description: "Original user directive or pseudocode, preserved verbatim",
      }),
      assignment: pi.typebox.Type.String({
        minLength: 1,
        description:
          "Bounded target, relevant context, fixed/inferred decisions, and expected behavior",
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!state.enabled)
        throw new Error("Conduct is off. The user must enable /conduct on before dispatch.");
      if (running)
        throw new Error(
          "A conduct worker is already running. Wait for it to finish before dispatching another.",
        );
      if (!state.model) throw new Error("Select a worker with /conduct model provider/id.");
      if (!params.directive.trim() || !params.assignment.trim())
        throw new Error("Directive and assignment must contain meaningful text.");
      const model = resolveLocalModel(ctx, state.model);
      const controller = new AbortController();
      const { promise: done, resolve: finish } = Promise.withResolvers<void>();
      const active: ActiveRun = { controller, done, finish };
      running = active;
      updateStatus(ctx);
      try {
        const result = await runWorker({
          ctx,
          model,
          directive: params.directive,
          assignment: params.assignment,
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
          onProgress: (progress) =>
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Local worker ${progress.status}; ${progress.toolCount} tool calls${progress.currentTool ? `; ${progress.currentTool}` : ""}.`,
                },
              ],
              details: { status: progress.status, model: progress.resolvedModel },
            }),
        });
        return {
          content: [
            {
              type: "text",
              text: [
                `Worker ${result.aborted ? "cancelled" : result.exitCode === 0 ? "finished; not yet reviewed" : "failed"}. Model: ${result.resolvedModel ?? state.model}.`,
                result.output,
                result.error,
                result.stderr,
                "Shared-workspace edits may already exist, including after failure or cancellation. Inspect the actual changes and verify behavior before reporting completion.",
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
          details: {
            status: result.aborted ? "aborted" : result.exitCode === 0 ? "completed" : "failed",
            model: result.resolvedModel,
            id: result.id,
            outputPath: result.outputPath,
          },
          isError: result.exitCode !== 0 || result.aborted === true,
        };
      } finally {
        if (running === active) running = undefined;
        active.finish();
        updateStatus(ctx);
      }
    },
  });
}
