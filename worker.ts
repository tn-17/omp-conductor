import type { Model } from "@oh-my-pi/pi-ai";
import {
  type AgentDefinition,
  type AgentProgress,
  AgentRegistry,
  type AgentSession,
  type ExtensionContext,
  type PreparedExtension,
  runSubprocess,
  type SingleResult,
} from "@oh-my-pi/pi-coding-agent";
import { AdviseTool } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { prompt } from "@oh-my-pi/pi-utils";
import assignmentTemplate from "./prompts/assignment.md" with { type: "text" };
import workerPrompt from "./prompts/worker.md" with { type: "text" };
import type { CandidateBrief } from "./candidates";
import { createIsolatedSettings } from "./session-settings";
import { createWorkerTools } from "./worker-tools";
import { assertNoExecutableCommands } from "./execution-policy";

// Post-render formatting would alter significant whitespace in user payloads.
const renderAssignment = prompt.compile(assignmentTemplate);

export function resolveAdvisorModel(ctx: ExtensionContext, selector: string): Model {
  const model = ctx.models
    .list()
    .find((candidate) => `${candidate.provider}/${candidate.id}` === selector);
  if (!model) {
    throw new Error(
      `Conduct advisor requires an available exact provider/model-id selector; not found: ${selector}`,
    );
  }
  return model;
}

export function resolveLocalModel(ctx: ExtensionContext, selector: string): Model {
  const model = ctx.models
    .list()
    .find((candidate) => `${candidate.provider}/${candidate.id}` === selector);
  if (!model) {
    throw new Error(
      `Conduct requires an available exact provider/model-id selector; not found: ${selector}`,
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(model.baseUrl);
  } catch {
    throw new Error(`Conduct model ${selector} has no valid HTTP(S) endpoint.`);
  }
  const host = endpoint.hostname;
  const loopback = host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || !loopback) {
    throw new Error(
      `Conduct model ${selector} must use a loopback HTTP(S) endpoint (localhost, 127/8, or ::1). Remote-local/LAN endpoints are unsupported; configure an explicit loopback endpoint instead.`,
    );
  }
  return model;
}

export async function runWorker(input: {
  ctx: ExtensionContext;
  model: Model;
  directive: string;
  assignment: string;
  brief: CandidateBrief;
  root: string;
  files: string[];
  worktree: string;
  signal: AbortSignal;
  onProgress: (progress: AgentProgress) => void;
}): Promise<SingleResult> {
  const { ctx, directive, assignment, signal, onProgress } = input;
  const selector = `${input.model.provider}/${input.model.id}`;
  // Revalidate the current registry rather than trusting a previously selected object.
  resolveLocalModel(ctx, selector);
  signal.throwIfAborted();
  await assertNoExecutableCommands(input.worktree);
  signal.throwIfAborted();
  const advisorModel =
    input.brief.advisorModel === undefined
      ? undefined
      : resolveAdvisorModel(ctx, input.brief.advisorModel);
  const id = `conduct-${Bun.randomUUIDv7()}`;
  const task = renderAssignment({ directive, assignment, brief: input.brief });
  const setupAbort = new AbortController();
  const workerSignal = AbortSignal.any([signal, setupAbort.signal]);
  let failure: Error | undefined;
  let child: AgentSession | undefined;
  let advisor: AgentSession["agent"] | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeAdvisor: (() => void) | undefined;
  let unsubscribeExecution: (() => void) | undefined;
  const fail = (message: string, source = "advisor") => {
    if (signal.aborted) return;
    failure ??= new Error(`Conduct ${source}: ${message}`);
    setupAbort.abort(failure);
    child?.agent.abort();
    advisor?.abort();
  };
  let stalledMutations = 0;
  const observedMutations = new WeakSet<object>();
  const observeMutation = (toolName: string, result: unknown, isError: boolean) => {
    if (!result || typeof result !== "object") return;
    const details = "details" in result ? result.details : undefined;
    // Core result coercion retains details by identity, while reconstructing
    // the outer result. Invocation-local identity also permits reused call IDs.
    const identity = details && typeof details === "object" ? details : result;
    if (
      failure ||
      signal.aborted ||
      (toolName !== "conduct_write" && toolName !== "conduct_edit") ||
      observedMutations.has(identity)
    ) return;
    observedMutations.add(identity);
    const changed =
      details && typeof details === "object" && "changed" in details ? details.changed : undefined;
    if (!isError && changed === true) {
      stalledMutations = 0;
    } else if (isError || changed === false) {
      stalledMutations++;
      if (stalledMutations >= 3) {
        fail(
          "stopped after three failed or unchanged mutations without a genuine byte change; correct rejected arguments or report the unresolved blocker in a fresh dispatch.",
          "worker",
        );
      }
    }
  };
  const agent: AgentDefinition = {
    name: "conduct-worker",
    description: "Local coding worker executing the frontier's bounded assignment",
    systemPrompt: workerPrompt,
    source: "project",
    tools: [],
    model: [selector],
    spawns: [],
    advisor: false,
    prewalk: false,
    readSummarize: false,
  };
  // Fresh defaults plus explicit pins: neither parent nor project settings can reroute this worker.
  const settings = createIsolatedSettings({
    model: selector,
    advisorModel: advisorModel ? `${advisorModel.provider}/${advisorModel.id}` : undefined,
    subagentTier: input.brief.workerFast === true ? "priority" : "none",
    advisorTier: input.brief.advisorFast === true ? "priority" : "none",
  });
  const customTools = await createWorkerTools({
    root: input.root,
    cwd: input.worktree,
    files: [...input.files],
    blockAutoGenerated: settings.get("edit.blockAutoGenerated"),
  });
  // tool_call runs during batch preparation, not necessarily just before a
  // queued call executes. Guard the actual boundary too, including provider
  // bridges that invoke tools without native execution-end notifications.
  let mutationQueue: Promise<unknown> = Promise.resolve();
  for (const tool of customTools) {
    const execute = tool.execute.bind(tool);
    const mutation = tool.name === "conduct_write" || tool.name === "conduct_edit";
    tool.execute = async (...args) => {
      const run = async () => {
        workerSignal.throwIfAborted();
        try {
          const result = await execute(...args);
          if (mutation) {
            result.details ??= {};
            observeMutation(tool.name, result, result.isError === true);
          }
          return result;
        } catch (error) {
          if (!mutation) throw error;
          const result = {
            content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
            details: {},
            isError: true,
          };
          observeMutation(tool.name, result, true);
          return result;
        }
      };
      if (!mutation) return run();
      const pending = mutationQueue.then(run);
      mutationQueue = pending.catch(() => {});
      return pending;
    };
  }
  agent.tools = customTools.map((tool) => tool.name);
  const allowedTools = new Set([...agent.tools, "yield"]);
  const policy: PreparedExtension = {
    path: "<conduct-worker-policy>",
    resolvedPath: "<conduct-worker-policy>",
    error: null,
    factory(pi) {
      pi.on("before_agent_start", async () => {
        await pi.setActiveTools([...allowedTools]);
        const nativeSession = AgentRegistry.global().get(id)?.session;
        // Session extension notifications can wait behind persistence. Observe
        // the same native event synchronously too, before queued writes start.
        if (nativeSession && !unsubscribeExecution) {
          unsubscribeExecution = nativeSession.agent.subscribe((event) => {
            if (event.type === "tool_execution_end") {
              observeMutation(event.toolName, event.result, event.isError === true);
            }
          });
        }
        if (!advisorModel) {
          child = nativeSession ?? undefined;
          return;
        }
        try {
          const session = AgentRegistry.global().get(id)?.session;
          if (!session) throw new Error("native worker session was not registered before startup");
          if (child) {
            if (session !== child || session.getAdvisorAgent() !== advisor) {
              throw new Error("native advisor runtime was replaced");
            }
            return;
          }
          child = session;
          // Discovery may have loaded WATCHDOG configs, but advisor:false keeps
          // them inert. Native names are required by the SDK's output quarantine.
          // Their native objects are extension-wrapped and denied by worker policy,
          // including after a rebuild or through the provider-side tool bridge.
          child.setAdvisorEnabled(false);
          const instructions = [
            "You are the Conduct read-only worker advisor. Review this worker's implementation for drift, ambiguity, and violations of the following pinned assignment.",
            "Use only read, grep, glob and native advise. These read tools use Conduct's guarded snapshot schemas: read takes path/startLine/endLine, grep takes pattern/path/ignoreCase/limit, glob takes pattern/path/limit. Never write, edit, execute commands, delegate, approve, apply, or expand scope. Advice is guidance, never human authorization.",
            "Read only guarded snapshot paths. Do not access original workspace paths, Git metadata, symlinks, or URI transports. Report blockers to the worker through advise.",
            task,
          ].join("\n\n");
          child.applyAdvisorConfigs(
            [
              {
                name: "Conduct",
                model: `${advisorModel.provider}/${advisorModel.id}`,
                tools: ["read", "grep", "glob"],
                instructions,
              },
            ],
            undefined,
          );
          if (!child.setAdvisorEnabled(true))
            throw new Error("the selected native advisor could not start");
          advisor = child.getAdvisorAgent();
          if (
            !advisor ||
            advisor.state.model.provider !== advisorModel.provider ||
            advisor.state.model.id !== advisorModel.id
          ) {
            throw new Error("native advisor did not resolve the exact selected model");
          }
          const advise = advisor.state.tools.find((tool) => tool.name === "advise");
          if (
            !(advise instanceof AdviseTool) ||
            advisor.state.tools.length !== 4 ||
            advisor.state.tools.some(
              (tool) => !["advise", "read", "grep", "glob"].includes(tool.name),
            )
          ) {
            throw new Error("native advisor exposed unexpected tools");
          }
          const reads = ["read", "grep", "glob"].map((name) => {
            const tool = child!.getToolByName(`conduct_${name}`);
            if (!tool) throw new Error(`guarded advisor tool unavailable: conduct_${name}`);
            // Forward to the worker's guarded, extension-wrapped instance; never
            // copy native prototypes or pass native filesystem tools to this loop.
            return {
              name,
              label: tool.label,
              description: tool.description,
              parameters: tool.parameters,
              execute: tool.execute.bind(tool),
            };
          });
          const safeTools = [advise, ...reads];
          advisor.setTools(safeTools);
          // Retain only the native advisor protocol, not discovered WATCHDOG,
          // project context, memory, or user advisor instructions.
          const protocol = advisor.state.systemPrompt[0];
          if (!protocol) throw new Error("native advisor protocol unavailable");
          advisor.setSystemPrompt([protocol, instructions]);
          advisor.beforeToolCall = ({ tool }) => {
            if (
              advisor!.state.model.provider !== advisorModel.provider ||
              advisor!.state.model.id !== advisorModel.id
            ) {
              fail("native advisor model changed from the pinned selection");
              return { block: true, reason: failure!.message };
            }
            if (!safeTools.includes(tool)) {
              return {
                block: true,
                reason: "Conduct advisor is read-only; use guarded snapshot reads or advise.",
              };
            }
            // Native advisors defer non-blockers until the entire primary run
            // yields. Conduct needs guidance between implementation steps.
            // Keep native filtering, deduplication, severity routing and delivery.
            if (tool === advise) advise.beginUpdate(false);
          };
          // Native runtime retries can roll back errors without emitting a
          // warning before worker disposal. Observe the terminal error first.
          unsubscribeAdvisor = advisor.subscribe((event) => {
            if (
              event.type === "message_end" &&
              event.message.role === "assistant" &&
              event.message.stopReason === "error"
            ) {
              fail(event.message.errorMessage ?? "native advisor provider failed");
            }
          });
          unsubscribe = child.subscribe((event) => {
            if (event.type === "notice" && event.source === "advisor" && event.level !== "info") {
              fail(event.message);
            }
          });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      });
      pi.on("tool_execution_end", (event) => {
        observeMutation(event.toolName, event.result, event.isError);
      });
      pi.on("tool_call", (event) => {
        if (workerSignal.aborted) {
          return { block: true, reason: failure?.message ?? "Conduct worker was cancelled." };
        }
        if (advisorModel && (!child || child.getAdvisorAgent() !== advisor)) {
          fail("native advisor safety setup is unavailable or changed");
          return { block: true, reason: failure!.message };
        }
        if (!allowedTools.has(event.toolName)) {
          return {
            block: true,
            reason: `Conduct worker cannot use ${event.toolName}. Use the guarded snapshot tools; request fresh human-authorized scope instead of bypassing restrictions.`,
          };
        }
      });
    },
  };
  let deferredCleanup: Promise<void> | undefined;
  let result: SingleResult;
  try {
    result = await runSubprocess({
      cwd: ctx.cwd,
      worktree: input.worktree,
      agent,
      task,
      assignment,
      description: "Conduct local coding assignment",
      index: 0,
      id,
      modelOverride: selector,
      modelRegistry: ctx.modelRegistry,
      settings,
      taskDepth: 0,
      enableIrc: false,
      enableLsp: false,
      enableMCP: false,
      // OMP's restricted-host mode drops custom tools. The explicit policy
      // extension instead gates every call, including dynamically added tools.
      restrictToolNames: false,
      customTools,
      context: "",
      contextFiles: [],
      skills: [],
      rules: [],
      promptTemplates: [],
      preloadedExtensionPaths: [],
      preloadedPreparedExtensions: [policy],
      preloadedCustomToolPaths: [],
      extensionRoots: () => ({
        explicit: [],
        mode: "explicit-only",
        configured: [],
        configuredLevel: "project",
      }),
      artifactsDir: ctx.sessionManager.getArtifactsDir() ?? undefined,
      signal: workerSignal,
      onProgress,
      onCleanupDeferred: (completion) => {
        deferredCleanup = completion;
      },
    });
  } catch (error) {
    throw failure ?? error;
  } finally {
    // Native executor drains final advice and disposes the isolated child.
    // Await late disposal and the advisor loop too before capturing files.
    try {
      await deferredCleanup;
    } finally {
      advisor?.abort();
      try {
        await advisor?.waitForIdle();
      } finally {
        unsubscribeAdvisor?.();
        unsubscribeExecution?.();
        unsubscribe?.();
      }
    }
  }
  if (failure) throw failure;
  if (advisorModel && !advisor && !signal.aborted) {
    throw new Error("Conduct advisor: native worker never completed safe advisor setup");
  }
  return result;
}
