import type { Model } from "@oh-my-pi/pi-ai";
import {
  type AgentDefinition,
  type AgentProgress,
  type ExtensionContext,
  runSubprocess,
  Settings,
  type SingleResult,
} from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";
import assignmentTemplate from "./prompts/assignment.md" with { type: "text" };
import workerPrompt from "./prompts/worker.md" with { type: "text" };

// Post-render formatting would alter significant whitespace in user payloads.
const renderAssignment = prompt.compile(assignmentTemplate);

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
  worktree: string;
  signal: AbortSignal;
  onProgress: (progress: AgentProgress) => void;
}): Promise<SingleResult> {
  const { ctx, directive, assignment, signal, onProgress } = input;
  const selector = `${input.model.provider}/${input.model.id}`;
  // Revalidate the current registry rather than trusting a previously selected object.
  resolveLocalModel(ctx, selector);
  const agent: AgentDefinition = {
    name: "conduct-worker",
    description: "Local coding worker executing the frontier's bounded assignment",
    systemPrompt: workerPrompt,
    source: "project",
    tools: ["read", "grep", "glob", "edit", "write"],
    model: [selector],
    spawns: [],
    advisor: false,
    prewalk: false,
    readSummarize: false,
  };
  // Fresh defaults plus explicit pins: neither parent nor project settings can reroute this worker.
  const settings = Settings.isolated({
    modelRoles: {
      default: selector,
      task: selector,
      smol: selector,
      slow: selector,
      vision: selector,
    },
    "task.agentModelOverrides": {},
    "task.agentAdvisor": {},
    "task.agentPrewalk": {},
    "task.maxRecursionDepth": 1,
    "task.prewalk": false,
    "advisor.enabled": false,
    "prewalk.enabled": false,
    "retry.modelFallback": false,
    "retry.usageAwareFallback": false,
    "retry.fallbackChains": {},
    "compaction.enabled": false,
    "contextPromotion.enabled": false,
    "recap.enabled": false,
    "branchSummary.enabled": false,
    "memory.backend": "off",
    "autolearn.enabled": false,
    "images.blockImages": true,
    "images.describeForTextModels": false,
    "images.urls.enabled": false,
    "fetch.enabled": false,
    "read.summarize.enabled": false,
    "edit.autoRepair.enabled": false,
    "edit.blackbox.enabled": false,
    "magicKeywords.enabled": false,
  });
  let deferredCleanup: Promise<void> | undefined;
  try {
    return await runSubprocess({
      cwd: ctx.cwd,
      worktree: input.worktree,
      agent,
      task: renderAssignment({ directive, assignment }),
      assignment,
      description: "Conduct local coding assignment",
      index: 0,
      id: `conduct-${Bun.randomUUIDv7()}`,
      modelOverride: selector,
      modelRegistry: ctx.modelRegistry,
      settings,
      taskDepth: 0,
      enableIrc: false,
      enableLsp: false,
      enableMCP: false,
      restrictToolNames: true,
      artifactsDir: ctx.sessionManager.getArtifactsDir() ?? undefined,
      localProtocolOptions: ctx.localProtocolOptions,
      signal,
      onProgress,
      onCleanupDeferred: (completion) => {
        deferredCleanup = completion;
      },
    });
  } finally {
    // Capture the candidate only after all worker-owned writes have stopped.
    await deferredCleanup;
  }
}
