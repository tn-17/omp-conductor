import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseCommandArgs } from "@oh-my-pi/pi-coding-agent/utils/command-args";
import { getAgentDir, prompt } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import {
  listCandidates,
  inspectCandidate,
  applyCandidate,
  rejectCandidate,
  recoverCandidates,
} from "./candidates";
import candidateDescription from "./prompts/candidate.md" with { type: "text" };
import candidateViewTemplate from "./prompts/candidate-view.md" with { type: "text" };
import conductSkill from "./prompts/SKILL.md" with { type: "text" };
import conductOff from "./prompts/off.md" with { type: "text" };
import taskDescription from "./prompts/task.md" with { type: "text" };
import selectDescription from "./prompts/select.md" with { type: "text" };
import selectionTemplate from "./prompts/selection.md" with { type: "text" };
import { readMarkerFile, selectMarker, type MarkerSelection } from "./selection";
import { resolveAdvisorModel, resolveLocalModel } from "./worker";
import { resolveReviewerModel } from "./reviewer";
import { parseVerificationArgs, validateVerification } from "./verification";
import type { VerificationConfig } from "./review-types";
import { runAssignments, type ConductAssignment, type AssignmentResult } from "./batch";

// Preserve interpolated source and assignment whitespace without post-render formatting.
const renderCandidateView = prompt.compile(candidateViewTemplate);
const renderSelection = prompt.compile(selectionTemplate);

const STATE_ENTRY = "conduct-state";
const TOOL = "conduct_task";
const BATCH_TOOL = "conduct_batch";
const SELECT_TOOL = "conduct_select";
const CANDIDATE_TOOL = "conduct_candidate";
const USAGE =
  '/conductor on | off [cancel] | status | workers [1..8] | model [provider/id] | advisor [off|provider/model-id] | reviewer [off|provider/model-id] | review-passes [1..10] | verify [off|command args...] | fast [worker|advisor|reviewer [on|off]] | cancel | markers "file" | select "file" [name|@line] | candidates | review id | apply id reviewToken | reject id';

interface ConductState {
  version: 1;
  enabled: boolean;
  workers: number;
  model?: string;
  advisorModel?: string;
  workerFast?: boolean;
  advisorFast?: boolean;
  reviewerModel?: string;
  reviewerFast?: boolean;
  reviewPasses?: number;
  verification?: VerificationConfig;
}

interface ActiveRun {
  phase: "worker" | "capture";
  stages?: Map<number, string>;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
}

function parseState(data: unknown): ConductState | undefined {
  if (!data || typeof data !== "object") return;
  if (!("version" in data) || data.version !== 1) return;
  if (!("enabled" in data) || typeof data.enabled !== "boolean") return;
  if ("model" in data && data.model !== undefined && typeof data.model !== "string") return;
  if (
    "advisorModel" in data &&
    data.advisorModel !== undefined &&
    (typeof data.advisorModel !== "string" || !/^[^/\s]+\/\S+$/.test(data.advisorModel))
  )
    return;
  if (
    ("workerFast" in data &&
      data.workerFast !== undefined &&
      typeof data.workerFast !== "boolean") ||
    ("advisorFast" in data &&
      data.advisorFast !== undefined &&
      typeof data.advisorFast !== "boolean")
  )
    return;
  if (
    "workers" in data &&
    data.workers !== undefined &&
    (typeof data.workers !== "number" ||
      !Number.isInteger(data.workers) ||
      data.workers < 1 ||
      data.workers > 8)
  )
    return;
  if (
    "reviewerModel" in data &&
    data.reviewerModel !== undefined &&
    (typeof data.reviewerModel !== "string" || !/^[^/\s]+\/\S+$/.test(data.reviewerModel))
  )
    return;
  if (
    "reviewerFast" in data &&
    data.reviewerFast !== undefined &&
    typeof data.reviewerFast !== "boolean"
  )
    return;
  if (
    "reviewPasses" in data &&
    data.reviewPasses !== undefined &&
    (typeof data.reviewPasses !== "number" ||
      !Number.isInteger(data.reviewPasses) ||
      data.reviewPasses < 1 ||
      data.reviewPasses > 10)
  )
    return;
  let verification: VerificationConfig | undefined;
  if ("verification" in data && data.verification !== undefined) {
    const value = data.verification;
    if (
      !value ||
      typeof value !== "object" ||
      !("argv" in value) ||
      !Array.isArray(value.argv) ||
      !value.argv.every((arg: unknown) => typeof arg === "string") ||
      !("timeoutMs" in value) ||
      value.timeoutMs !== 120000
    )
      return;
    verification = { argv: [...value.argv], timeoutMs: 120000 };
    try {
      validateVerification(verification);
    } catch {
      return;
    }
  }
  return {
    version: 1,
    enabled: data.enabled,
    reviewerModel:
      "reviewerModel" in data && typeof data.reviewerModel === "string"
        ? data.reviewerModel
        : undefined,
    reviewerFast: "reviewerFast" in data && data.reviewerFast === true,
    reviewPasses:
      "reviewPasses" in data && typeof data.reviewPasses === "number" ? data.reviewPasses : 3,
    verification,
    workers: "workers" in data && typeof data.workers === "number" ? data.workers : 1,
    workerFast: "workerFast" in data && data.workerFast === true,
    advisorFast: "advisorFast" in data && data.advisorFast === true,
    model: "model" in data && typeof data.model === "string" ? data.model : undefined,
    advisorModel:
      "advisorModel" in data && typeof data.advisorModel === "string"
        ? data.advisorModel
        : undefined,
  };
}

export default function conductExtension(pi: ExtensionAPI): void {
  let state: ConductState = {
    version: 1,
    enabled: false,
    workers: 1,
    workerFast: false,
    advisorFast: false,
    reviewerFast: false,
    reviewPasses: 3,
  };
  let hasState = false;
  let running: ActiveRun | undefined;
  let selected: MarkerSelection | undefined;
  const selections = new Map<string, MarkerSelection>();

  function rememberSelection(selection: MarkerSelection): MarkerSelection {
    for (const [id, previous] of selections) {
      if (
        (previous.path === selection.path || previous.realPath === selection.realPath) &&
        (previous.realPath !== selection.realPath ||
          previous.digest !== selection.digest ||
          previous.startLine === selection.startLine)
      )
        selections.delete(id);
    }
    selected = selection;
    selections.set(selection.id, selection);
    return selection;
  }
  let selectionEpoch = 0;
  let sessionEpoch = 0;
  let operation = false;
  let retained = false;

  const store = (ctx: ExtensionContext) =>
    path.join(getAgentDir(), "conduct", ctx.sessionManager.getSessionId());
  function assertEpoch(epoch: number): void {
    if (epoch !== sessionEpoch) throw new Error("Session changed; retry in the current session.");
  }

  function reviewStatus(): string {
    return `reviewer ${state.reviewerModel ?? "off"} | reviewer fast ${state.reviewerFast === true ? "on" : "off"} | reviews ${state.reviewPasses ?? 3} | verify ${state.verification ? `${JSON.stringify(state.verification.argv)} (120000ms, trusted host)` : "off"}`;
  }

  function stageStatus(): string {
    return running?.stages?.size
      ? [...running.stages].map(([index, stage]) => `task ${index + 1}: ${stage}`).join("; ")
      : "invocation running";
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "conductor",
      state.enabled
        ? `Conduct: on | workers ${state.workers} | advisor ${state.advisorModel ?? "off"} | requested fast worker ${state.workerFast === true ? "on" : "off"}, advisor ${state.advisorFast === true ? "on" : "off"} | ${reviewStatus()}${running ? (running.phase === "worker" ? ` | ${stageStatus()}` : " | capturing candidates") : ""}`
        : undefined,
    );
  }

  async function syncTool(ctx: ExtensionContext): Promise<void> {
    const active = pi.getActiveTools();
    const owned = [TOOL, BATCH_TOOL, SELECT_TOOL, CANDIDATE_TOOL];
    const desired = [
      ...(state.enabled ? [TOOL, BATCH_TOOL, SELECT_TOOL] : []),
      ...(state.enabled || retained ? [CANDIDATE_TOOL] : []),
    ];
    await pi.setActiveTools([...active.filter((name) => !owned.includes(name)), ...desired]);
    updateStatus(ctx);
  }

  function persist(): void {
    hasState = true;
    pi.appendEntry(STATE_ENTRY, { ...state });
  }

  async function restore(ctx: ExtensionContext): Promise<void> {
    const epoch = ++sessionEpoch;
    await cancelWorker();
    assertEpoch(epoch);
    selectionEpoch++;
    selected = undefined;
    selections.clear();
    state = {
      version: 1,
      enabled: false,
      workers: 1,
      workerFast: false,
      advisorFast: false,
      reviewerFast: false,
      reviewPasses: 3,
    };
    hasState = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const saved = parseState(entry.data);
      if (saved) {
        state = saved;
        hasState = true;
      }
    }
    await recoverCandidates(store(ctx), ctx.cwd);
    assertEpoch(epoch);
    retained = (await listCandidates(store(ctx), ctx.cwd)).length > 0;
    assertEpoch(epoch);
    await syncTool(ctx);
  }

  async function cancelWorker(): Promise<"cancelled" | "ended" | undefined> {
    const active = running;
    if (!active) return;
    const outcome = active.phase === "worker" ? "cancelled" : "ended";
    if (outcome === "cancelled") active.controller.abort();
    await active.done;
    return outcome;
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
          "No configured loopback model is available. Configure a local model in OMP, then use /conductor model provider/id.",
        );
      if (!ctx.hasUI)
        throw new Error(
          `Choose an exact model with /conductor model provider/id. Available: ${choices.join(", ")}`,
        );
      const epoch = sessionEpoch;
      selected = await ctx.ui.select("Conduct local worker", choices);
      assertEpoch(epoch);
      if (!selected) return false;
    }
    const model = resolveLocalModel(ctx, selected);
    state = { ...state, model: `${model.provider}/${model.id}` };
    persist();
    return true;
  }

  const commandOptions = [
    { name: "on", description: "Enable Conduct mode" },
    {
      name: "off",
      description: "Disable Conduct; optionally cancel active work",
      hint: "[cancel]",
    },
    { name: "status", description: "Show Conduct configuration and activity" },
    { name: "workers", description: "Show or set the worker limit", hint: "[1..8]" },
    { name: "model", description: "Choose the local worker model", hint: "[provider/id]" },
    {
      name: "advisor",
      description: "Show, choose, or disable the worker advisor",
      hint: "[off|provider/model-id]",
    },
    {
      name: "fast",
      description: "Show or set independent priority preferences",
      hint: "[worker|advisor|reviewer [on|off]]",
    },
    {
      name: "reviewer",
      description: "Show, choose, or disable the read-only reviewer",
      hint: "[off|provider/model-id]",
    },
    {
      name: "review-passes",
      description: "Set total reviews; 3 permits at most 2 corrections",
      hint: "[1..10]",
    },
    {
      name: "verify",
      description: "Configure trusted-host test argv; no implicit shell or installs",
      hint: "[off|command args...]",
    },
    { name: "cancel", description: "Cancel unfinished work and await candidate capture" },
    { name: "markers", description: "List deferred directives in a file", hint: '"file"' },
    {
      name: "select",
      description: "Preview a deferred directive without dispatching",
      hint: '"file" [name|@line]',
    },
    { name: "candidates", description: "List retained candidates" },
    {
      name: "review",
      description: "Inspect a candidate patch and obtain its review token",
      hint: "id",
    },
    {
      name: "apply",
      description: "Apply an explicitly reviewed candidate",
      hint: "id reviewToken",
    },
    { name: "reject", description: "Reject a retained candidate", hint: "id" },
  ];
  pi.registerCommand("conductor", {
    description: "Prepare protected local-worker candidates; review and explicitly apply them",
    getArgumentCompletions: (argumentPrefix) => {
      if (/\s/.test(argumentPrefix)) return null;
      const prefix = argumentPrefix.toLowerCase();
      const matches = commandOptions
        .filter((option) => option.name.startsWith(prefix))
        .map((option) => ({
          value: `${option.name} `,
          label: option.name,
          description: option.hint ? `${option.description} — ${option.hint}` : option.description,
        }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const [action = "status", ...rest] = parseCommandArgs(args);
      if (operation) {
        ctx.ui.notify("Another Conduct operation is in progress.", "warning");
        return;
      }
      operation = true;
      const epoch = sessionEpoch;
      try {
        switch (action) {
          case "candidates":
          case "review":
          case "apply":
          case "reject": {
            const count = action === "candidates" ? 0 : action === "apply" ? 2 : 1;
            if (rest.length !== count) throw new Error(USAGE);
            if (running) throw new Error("Finish or cancel the worker before managing candidates.");
            if (action === "apply" && !state.enabled)
              throw new Error("Conduct is off. Enable /conductor on before applying.");
            if (action === "candidates") {
              const candidates = await listCandidates(store(ctx), ctx.cwd);
              assertEpoch(epoch);
              ctx.ui.notify(
                candidates.map((c) => `${c.id}: ${c.status} (${c.files.join(", ")})`).join("\n") ||
                  "No candidates.",
                "info",
              );
            } else if (action === "review") {
              const view = await inspectCandidate(store(ctx), ctx.cwd, rest[0]);
              assertEpoch(epoch);
              pi.sendMessage(
                {
                  customType: "conduct-candidate",
                  content: renderCandidateView({
                    ...view.candidate,
                    verificationCommand: view.candidate.brief?.verification
                      ? JSON.stringify(view.candidate.brief.verification.argv)
                      : undefined,
                    reviewLines: view.candidate.review
                      ? JSON.stringify(view.candidate.review, null, 2).split("\n")
                      : undefined,
                    patchLines: view.patch.split(/\r?\n/),
                    approval: view.reviewToken
                      ? `/conductor apply ${view.candidate.id} ${view.reviewToken}`
                      : "Not applicable.",
                  }),
                  display: true,
                  details: view,
                },
                { triggerTurn: false },
              );
            } else {
              const candidate =
                action === "apply"
                  ? await applyCandidate(store(ctx), ctx.cwd, rest[0], rest[1])
                  : await rejectCandidate(store(ctx), ctx.cwd, rest[0]);
              assertEpoch(epoch);
              ctx.ui.notify(`Candidate ${candidate.id}: ${candidate.status}.`, "info");
            }
            return;
          }
          case "status":
            if (rest.length) throw new Error(USAGE);
            ctx.ui.notify(
              `Conduct ${state.enabled ? "on" : "off"}. Worker: ${state.model ?? "not selected"}. Worker limit: ${state.workers}. Advisor: ${state.advisorModel ?? "off"}. Requested fast: worker ${state.workerFast === true ? "on" : "off"}; advisor ${state.advisorFast === true ? "on" : "off"}. ${reviewStatus()}. ${running ? `${stageStatus()}.` : "Idle."} ${selected ? `Selected: ${selected.path}:${selected.startLine}-${selected.endLine}.` : "No marker selected."} Protected unapplied candidates; explicit human application; no OS sandbox.`,
              "info",
            );
            return;
          case "markers":
          case "select": {
            if (rest.length < 1 || rest.length > (action === "markers" ? 1 : 2))
              throw new Error(USAGE);
            if (running)
              throw new Error("Finish or cancel the worker before selecting another directive.");
            const selectionVersion = ++selectionEpoch;
            const file = await readMarkerFile(ctx.cwd, rest[0]);
            assertEpoch(epoch);
            if (selectionVersion !== selectionEpoch)
              throw new Error("Selection was superseded; select again.");
            if (action === "markers") {
              ctx.ui.notify(
                file.regions.length
                  ? file.regions
                      .map(
                        (region) =>
                          `${region.name ?? "(unnamed)"} @${region.startLine} (${region.startLine}-${region.endLine})`,
                      )
                      .join("\n")
                  : `No OMP-CONDUCT directives in ${file.path}.`,
                "info",
              );
              return;
            }
            const selector = rest[1];
            if (selector?.startsWith("@") && !/^@[1-9]\d*$/.test(selector))
              throw new Error("Use @ followed by the marker's positive start line.");
            selected = rememberSelection(
              selectMarker(
                file,
                selector?.startsWith("@")
                  ? { line: Number(selector.slice(1)) }
                  : selector === undefined
                    ? {}
                    : { marker: selector },
              ),
            );
            pi.sendMessage(
              {
                customType: "conduct-selection",
                content: renderSelection({
                  ...selected,
                  selection: selected.id,
                  directiveLines: selected.directive.split(/\r?\n/),
                }),
                display: true,
                details: {
                  selection: selected.id,
                  path: selected.path,
                  marker: selected.name,
                  startLine: selected.startLine,
                  endLine: selected.endLine,
                },
              },
              { triggerTurn: false },
            );
            return;
          }
          case "workers": {
            if (rest.length > 1 || (rest.length === 1 && !/^[1-8]$/.test(rest[0])))
              throw new Error("Use /conductor workers [1..8]; specify an explicit integer.");
            if (rest.length) {
              if (running)
                throw new Error("Finish or cancel the invocation before changing workers.");
              state = { ...state, workers: Number(rest[0]) };
              persist();
              updateStatus(ctx);
            }
            ctx.ui.notify(
              `Conduct worker limit: ${state.workers}. Batches require independent tasks with disjoint exact writable files; no queue or dependency scheduling.`,
              "info",
            );
            return;
          }
          case "fast": {
            const [target, value] = rest;
            if (
              rest.length > 2 ||
              (target !== undefined &&
                target !== "worker" &&
                target !== "advisor" &&
                target !== "reviewer") ||
              (value !== undefined && value !== "on" && value !== "off")
            )
              throw new Error("Use /conductor fast [worker|advisor|reviewer [on|off]].");
            if (value !== undefined) {
              if (running)
                throw new Error("Cancel or finish the worker before changing fast preferences.");
              state = {
                ...state,
                [target === "worker"
                  ? "workerFast"
                  : target === "advisor"
                    ? "advisorFast"
                    : "reviewerFast"]: value === "on",
              };
              persist();
              updateStatus(ctx);
            }
            const report =
              target === undefined
                ? `worker ${state.workerFast === true ? "on" : "off"}; advisor ${state.advisorFast === true ? "on" : "off"}; reviewer ${state.reviewerFast === true ? "on" : "off"}`
                : `${target} ${state[target === "worker" ? "workerFast" : target === "advisor" ? "advisorFast" : "reviewerFast"] === true ? "on" : "off"}`;
            ctx.ui.notify(
              `Conduct requested fast: ${report}. On requests priority and may cost more; unsupported/local providers may ignore or reject it. Advisor and reviewer fast preferences do not enable those roles.`,
              "info",
            );
            return;
          }
          case "review-passes":
            if (rest.length > 1 || (rest.length === 1 && !/^(?:[1-9]|10)$/.test(rest[0])))
              throw new Error("Use /conductor review-passes [1..10]; specify total reviews.");
            if (rest.length) {
              if (running)
                throw new Error("Finish or cancel the invocation before changing review passes.");
              state = { ...state, reviewPasses: Number(rest[0]) };
              persist();
              updateStatus(ctx);
            }
            ctx.ui.notify(
              `Conduct total reviews: ${state.reviewPasses ?? 3}; at most ${(state.reviewPasses ?? 3) - 1} corrections. Remaining findings or failed verification at the cap require attention, never automatic approval.`,
              "info",
            );
            return;
          case "verify": {
            const [verb, ...argv] = parseVerificationArgs(args);
            if (verb !== "verify") throw new Error(USAGE);
            if (argv.length) {
              if (running)
                throw new Error("Finish or cancel the invocation before changing verification.");
              if (argv[0] === "off" && argv.length !== 1) throw new Error(USAGE);
              const verification = argv[0] === "off" ? undefined : { argv, timeoutMs: 120000 };
              if (verification) validateVerification(verification);
              state = { ...state, verification };
              persist();
              updateStatus(ctx);
            }
            ctx.ui.notify(
              `Conduct verification: ${state.verification ? `${JSON.stringify(state.verification.argv)}; timeout 120000ms. TRUSTED HOST: project code has inherited host permissions and environment; it can read secrets, modify host/source files, access the network, and launch processes. The disposable copy is NOT a sandbox. Arguments and bounded output are retained and shared with the configured reviewer and correction worker. No implicit shell, dependency installation, or execution at configuration time. Ignored node_modules are not copied; configure an appropriate command and dependencies.` : "off."}`,
              state.verification ? "warning" : "info",
            );
            return;
          }
          case "reviewer":
            if (rest.length > 1) throw new Error(USAGE);
            if (rest.length) {
              if (running)
                throw new Error("Finish or cancel the invocation before changing its reviewer.");
              const reviewer = rest[0] === "off" ? undefined : resolveReviewerModel(ctx, rest[0]);
              state = {
                ...state,
                reviewerModel: reviewer ? `${reviewer.provider}/${reviewer.id}` : undefined,
              };
              persist();
              updateStatus(ctx);
            }
            ctx.ui.notify(
              `Conduct reviewer: ${state.reviewerModel ?? "off"}.${state.reviewerModel ? " Opt-in read-only review may disclose snapshot, task, patch, and verification data to the selected provider. Reviews do not widen scope or replace frontier review and explicit human application." : ""}`,
              state.reviewerModel ? "warning" : "info",
            );
            return;
          case "advisor":
            if (rest.length > 1) throw new Error(USAGE);
            if (rest.length) {
              if (running)
                throw new Error("Cancel or finish the worker before changing its advisor.");
              const advisor = rest[0] === "off" ? undefined : resolveAdvisorModel(ctx, rest[0]);
              state = {
                ...state,
                advisorModel: advisor ? `${advisor.provider}/${advisor.id}` : undefined,
              };
              persist();
              updateStatus(ctx);
            }
            ctx.ui.notify(
              `Conduct worker advisor: ${state.advisorModel ?? "off"}.${state.advisorModel ? " Opt-in advisor access may disclose worker snapshot and task data to the selected provider. Advice does not approve changes or widen scope." : ""}`,
              state.advisorModel ? "warning" : "info",
            );
            return;
          case "model":
            if (rest.length > 1) throw new Error(USAGE);
            if (await selectModel(ctx, rest[0]))
              ctx.ui.notify(`Conduct worker: ${state.model}`, "info");
            return;
          case "on":
            if (rest.length) throw new Error(USAGE);
            if (running) throw new Error("Finish or cancel the invocation before changing mode.");
            if (!state.model && !(await selectModel(ctx))) return;
            assertEpoch(epoch);
            resolveLocalModel(ctx, state.model!);
            state = { ...state, enabled: true };
            persist();
            await syncTool(ctx);
            assertEpoch(epoch);
            ctx.ui.notify(
              "Conduct on. A Git repository and saved files are required. Workers edit copied snapshots, not source targets; candidates require review and an explicit human apply command. This is not an OS sandbox. Nothing is dispatched by enabling the mode.",
              "warning",
            );
            return;
          case "off": {
            if (rest.length > 1 || (rest.length === 1 && rest[0] !== "cancel"))
              throw new Error(USAGE);
            if (running && rest[0] !== "cancel") {
              ctx.ui.notify(
                "Invocation still running. Use /conductor off cancel to cancel unfinished work and preserve candidates, or let it finish first. Conduct does not apply patches automatically; trusted verification can affect host/source files.",
                "warning",
              );
              return;
            }
            state = { ...state, enabled: false };
            selectionEpoch++;
            selected = undefined;
            selections.clear();
            persist();
            const outcome = await cancelWorker();
            assertEpoch(epoch);
            await syncTool(ctx);
            assertEpoch(epoch);
            ctx.ui.notify(
              outcome === "ended"
                ? "Conduct off. Workers had already ended; capture finished and candidates remain available for review and rejection. Nothing was applied."
                : outcome === "cancelled"
                  ? "Conduct off. Unfinished workers cancelled; candidates retained for inspection. Nothing was applied."
                  : "Conduct off. Retained candidates remain available for review and rejection; nothing was applied.",
              "info",
            );
            return;
          }
          case "cancel": {
            if (rest.length) throw new Error(USAGE);
            if (!running) {
              ctx.ui.notify("No conduct invocation is running.", "info");
              return;
            }
            const outcome = await cancelWorker();
            assertEpoch(epoch);
            ctx.ui.notify(
              outcome === "ended"
                ? "Workers had already ended. Capture finished and candidates were retained for inspection; source targets were not applied."
                : "Unfinished workers cancelled. Candidates retained for inspection; source targets were not applied.",
              outcome === "ended" ? "info" : "warning",
            );
            return;
          }
          default:
            throw new Error(USAGE);
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        operation = false;
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_switch", async (_event, ctx) => restore(ctx));
  pi.on("session_branch", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  const blockTransition = (_event: unknown, ctx: ExtensionContext) => {
    if (!running && !operation) return;
    ctx.ui.notify(
      "Finish the Conduct operation or cancel the worker before switching sessions or branches.",
      "warning",
    );
    return { cancel: true };
  };
  pi.on("session_before_switch", blockTransition);
  pi.on("session_before_branch", blockTransition);
  pi.on("session_before_tree", blockTransition);
  pi.on("session_shutdown", async () => {
    await cancelWorker();
  });
  pi.on("before_agent_start", (event) => {
    if (!hasState) return;
    return { systemPrompt: [...event.systemPrompt, state.enabled ? conductSkill : conductOff] };
  });

  pi.registerTool({
    name: SELECT_TOOL,
    label: "Select conduct directive",
    description: selectDescription,
    defaultInactive: true,
    loadMode: "essential",
    approval: "read",
    parameters: pi.typebox.Type.Object({
      path: pi.typebox.Type.String({
        minLength: 1,
        description: "Explicit source file; relative to the working directory or absolute",
      }),
      marker: pi.typebox.Type.Optional(
        pi.typebox.Type.Union([pi.typebox.Type.String({ minLength: 1 }), pi.typebox.Type.Null()], {
          description: "Exact paired-marker name; null or omitted when using line",
        }),
      ),
      line: pi.typebox.Type.Optional(
        pi.typebox.Type.Union([pi.typebox.Type.Integer({ minimum: 1 }), pi.typebox.Type.Null()], {
          description: "Marker start line; null or omitted when using marker",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!state.enabled)
        throw new Error("Conduct is off. Enable /conductor on before using conduct_select.");
      if (running || operation)
        throw new Error(
          "Finish the Conduct operation or cancel the worker before selecting another directive.",
        );
      if (params.marker != null && params.line != null)
        throw new Error("Select by marker name OR start line, not both.");
      operation = true;
      try {
        const epoch = ++selectionEpoch;
        const session = sessionEpoch;
        const file = await readMarkerFile(ctx.cwd, params.path);
        assertEpoch(session);
        signal?.throwIfAborted();
        if (epoch !== selectionEpoch) throw new Error("Selection was superseded; select again.");
        if (params.marker == null && params.line == null && file.regions.length !== 1) {
          return {
            content: [
              {
                type: "text",
                text: file.regions.length
                  ? file.regions
                      .map(
                        (region) =>
                          `${region.name ?? "(unnamed)"} @${region.startLine} (${region.startLine}-${region.endLine})`,
                      )
                      .join("\n")
                  : `No OMP-CONDUCT directives in ${file.path}.`,
              },
            ],
            details: { path: file.path, markers: file.regions },
          };
        }
        selected = rememberSelection(
          selectMarker(file, {
            marker: params.marker ?? undefined,
            line: params.line ?? undefined,
          }),
        );
        return {
          content: [
            {
              type: "text",
              text: renderSelection({
                ...selected,
                selection: selected.id,
                directiveLines: selected.directive.split(/\r?\n/),
              }),
            },
          ],
          details: {
            selection: selected.id,
            path: selected.path,
            marker: selected.name,
            startLine: selected.startLine,
            endLine: selected.endLine,
            directive: selected.directive,
          },
        };
      } finally {
        operation = false;
      }
    },
  });

  pi.registerTool({
    name: CANDIDATE_TOOL,
    label: "Inspect Conduct candidates",
    description: candidateDescription,
    defaultInactive: true,
    loadMode: "essential",
    approval: "read",
    parameters: pi.typebox.Type.Object({
      id: pi.typebox.Type.Optional(
        pi.typebox.Type.Union([pi.typebox.Type.String({ minLength: 1 }), pi.typebox.Type.Null()]),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (operation || running)
        throw new Error("Finish the Conduct operation or worker before reviewing candidates.");
      operation = true;
      const epoch = sessionEpoch;
      try {
        signal?.throwIfAborted();
        if (params.id) {
          const view = await inspectCandidate(store(ctx), ctx.cwd, params.id);
          assertEpoch(epoch);
          signal?.throwIfAborted();
          return {
            content: [
              {
                type: "text",
                text: renderCandidateView({
                  ...view.candidate,
                  verificationCommand: view.candidate.brief?.verification
                    ? JSON.stringify(view.candidate.brief.verification.argv)
                    : undefined,
                  reviewLines: view.candidate.review
                    ? JSON.stringify(view.candidate.review, null, 2).split("\n")
                    : undefined,
                  patchLines: view.patch.split(/\r?\n/),
                  approval: view.reviewToken
                    ? `/conductor apply ${view.candidate.id} ${view.reviewToken}`
                    : "Not applicable.",
                }),
              },
            ],
            details: view,
          };
        }
        const candidates = await listCandidates(store(ctx), ctx.cwd);
        assertEpoch(epoch);
        return {
          content: [
            {
              type: "text",
              text:
                candidates.map((c) => `${c.id}: ${c.status} (${c.files.join(", ")})`).join("\n") ||
                "No candidates.",
            },
          ],
          details: { candidates },
        };
      } finally {
        operation = false;
      }
    },
  });

  const taskParameters = pi.typebox.Type.Object({
    directive: pi.typebox.Type.Optional(
      pi.typebox.Type.Union([pi.typebox.Type.String({ minLength: 1 }), pi.typebox.Type.Null()], {
        description: "Freeform user directive, verbatim; null or omitted when using selection",
      }),
    ),
    selection: pi.typebox.Type.Optional(
      pi.typebox.Type.Union([pi.typebox.Type.String({ minLength: 1 }), pi.typebox.Type.Null()], {
        description:
          "Token from conduct_select or /conductor select; null or omitted when using directive",
      }),
    ),
    files: pi.typebox.Type.Array(pi.typebox.Type.String({ minLength: 1 }), {
      minItems: 1,
      description:
        "Exact writable files, relative to cwd or absolute inside the Git repository; no directories or globs",
    }),
    assignment: pi.typebox.Type.String({
      minLength: 1,
      description: "Bounded implementation task",
    }),
    context: pi.typebox.Type.String({
      minLength: 1,
      description: "Relevant surrounding code, callers, and read-only context",
    }),
    fixedDecisions: pi.typebox.Type.Array(pi.typebox.Type.String({ minLength: 1 }), {
      description: "Fixed requirements and decisions; empty only when none are fixed",
    }),
    acceptance: pi.typebox.Type.Array(pi.typebox.Type.String({ minLength: 1 }), {
      minItems: 1,
      description: "Observable conditions the implementation must satisfy",
    }),
  });

  type TaskParams = Omit<ConductAssignment, "directive" | "selection"> & {
    directive?: string | null;
    selection?: string | null;
  };
  type ProgressUpdate = {
    content: { type: "text"; text: string }[];
    details: Record<string, unknown>;
  };

  async function dispatch(
    tasks: TaskParams[],
    signal: AbortSignal | undefined,
    onUpdate: ((update: ProgressUpdate) => void) | undefined,
    ctx: ExtensionContext,
  ): Promise<AssignmentResult[]> {
    if (!state.enabled)
      throw new Error("Conduct is off. The user must enable /conductor on before dispatch.");
    if (running)
      throw new Error(
        "A conduct invocation is already running. Wait for it to finish before dispatching another.",
      );
    if (operation) throw new Error("Another Conduct operation is in progress.");
    if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 8)
      throw new Error("Provide between 1 and 8 tasks.");
    if (tasks.length > state.workers)
      throw new Error(
        `Batch has ${tasks.length} tasks but the configured worker limit is ${state.workers}. The human must set /conductor workers before dispatch.`,
      );
    if (!state.model) throw new Error("Select a worker with /conductor model provider/id.");
    const assignments = tasks.map((task): ConductAssignment => {
      if ((task.directive == null) === (task.selection == null))
        throw new Error("Provide exactly one of directive or selection.");
      const chosen = task.selection == null ? undefined : selections.get(task.selection);
      if (task.selection != null && !chosen)
        throw new Error("Unknown or expired selection. Reselect the directive before dispatch.");
      return { ...task, directive: task.directive ?? undefined, selection: chosen };
    });
    const model = resolveLocalModel(ctx, state.model);
    const { advisorModel, workerFast, advisorFast, reviewerModel, reviewerFast, reviewPasses } =
      state;
    const verification = state.verification
      ? { argv: [...state.verification.argv], timeoutMs: state.verification.timeoutMs }
      : undefined;
    if (advisorModel) resolveAdvisorModel(ctx, advisorModel);
    if (reviewerModel) resolveReviewerModel(ctx, reviewerModel);
    if (verification) validateVerification(verification);
    const controller = new AbortController();
    const { promise: done, resolve: finish } = Promise.withResolvers<void>();
    const active: ActiveRun = { phase: "worker", stages: new Map(), controller, done, finish };
    running = active;
    selectionEpoch++;
    selections.clear();
    selected = undefined;
    updateStatus(ctx);
    const epoch = sessionEpoch;
    const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const results = await runAssignments({
        ctx,
        storeDir: store(ctx),
        assignments,
        model,
        advisorModel,
        workerFast,
        advisorFast,
        reviewerModel,
        reviewerFast,
        reviewPasses: reviewPasses ?? 3,
        verification,
        signal: runSignal,
        onPrepared: () => {
          retained = true;
        },
        onPhase: (phase) => {
          active.phase = phase;
          updateStatus(ctx);
        },
        onStage: (index, stage) => {
          active.stages?.set(index, stage);
          updateStatus(ctx);
          onUpdate?.({
            content: [{ type: "text", text: `Task ${index + 1}/${tasks.length}: ${stage}.` }],
            details: { index, count: tasks.length, stage },
          });
        },
        onProgress: (index, progress, stage = "implementation") =>
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Task ${index + 1}/${tasks.length}: ${stage} ${progress.status}; advisor ${advisorModel ?? "off"}; reviewer ${reviewerModel ?? "off"}; requested fast worker ${workerFast === true ? "on" : "off"}, advisor ${advisorFast === true ? "on" : "off"}, reviewer ${reviewerFast === true ? "on" : "off"}; ${progress.toolCount} tool calls${progress.currentTool ? `; ${progress.currentTool}` : ""}.`,
              },
            ],
            details: {
              index,
              count: tasks.length,
              status: progress.status,
              stage,
              reviewerModel,
              reviewerFast: reviewerFast === true,
              reviewPasses: reviewPasses ?? 3,
              verification,
              model: progress.resolvedModel,
              advisorModel,
              workerFast: workerFast === true,
              advisorFast: advisorFast === true,
            },
          }),
      });
      assertEpoch(epoch);
      return results;
    } finally {
      if (running === active) running = undefined;
      active.finish();
      if (epoch === sessionEpoch) await syncTool(ctx);
    }
  }

  pi.registerTool({
    name: TOOL,
    label: "Conduct worker",
    description: taskDescription,
    defaultInactive: true,
    loadMode: "essential",
    approval: "write",
    parameters: taskParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const [result] = await dispatch([params], signal, onUpdate, ctx);
      return result;
    },
  });

  pi.registerTool({
    name: BATCH_TOOL,
    label: "Conduct worker batch",
    description: `Run independent Conduct assignments concurrently, returning ordered per-task candidates after all workers and capture finish. Supply tasks using the conduct_task handoff schema. Exact writable ownership must be disjoint, including ancestor paths. The human-configured /conductor workers limit defaults to 1 and cannot exceed 8. No queue, dependencies, automatic apply, or background work. One failed task does not cancel siblings; /conductor cancel cancels all unfinished workers. Review and apply each candidate separately.\n\n${taskDescription}`,
    defaultInactive: true,
    loadMode: "essential",
    approval: "write",
    parameters: pi.typebox.Type.Object({
      tasks: pi.typebox.Type.Array(taskParameters, { minItems: 1, maxItems: 8 }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const results = await dispatch(params.tasks, signal, onUpdate, ctx);
      return {
        content: results.map((result, index) => ({
          type: "text" as const,
          text: `Task ${index + 1}/${results.length}\n${result.content.map((item) => item.text).join("\n")}`,
        })),
        details: { results },
        isError: results.some((result) => result.isError),
      };
    },
  });
}
