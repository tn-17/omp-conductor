import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseCommandArgs } from "@oh-my-pi/pi-coding-agent/utils/command-args";
import { getAgentDir, prompt } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import {
  prepareCandidate,
  finishCandidate,
  listCandidates,
  inspectCandidate,
  applyCandidate,
  rejectCandidate,
  recoverCandidates,
  type PreparedCandidate,
} from "./candidates";
import candidateDescription from "./prompts/candidate.md" with { type: "text" };
import candidateViewTemplate from "./prompts/candidate-view.md" with { type: "text" };
import conductSkill from "./prompts/SKILL.md" with { type: "text" };
import conductOff from "./prompts/off.md" with { type: "text" };
import taskDescription from "./prompts/task.md" with { type: "text" };
import selectDescription from "./prompts/select.md" with { type: "text" };
import selectionTemplate from "./prompts/selection.md" with { type: "text" };
import markerAssignmentTemplate from "./prompts/marker-assignment.md" with { type: "text" };
import { readMarkerFile, selectMarker, verifySelection, type MarkerSelection } from "./selection";
import { resolveAdvisorModel, resolveLocalModel, runWorker } from "./worker";

// Preserve interpolated source and assignment whitespace without post-render formatting.
const renderCandidateView = prompt.compile(candidateViewTemplate);
const renderSelection = prompt.compile(selectionTemplate);
const renderMarkerAssignment = prompt.compile(markerAssignmentTemplate);

const STATE_ENTRY = "conduct-state";
const TOOL = "conduct_task";
const SELECT_TOOL = "conduct_select";
const CANDIDATE_TOOL = "conduct_candidate";
const USAGE =
  '/conduct on | off [cancel] | status | model [provider/id] | advisor [off|provider/model-id] | cancel | markers "file" | select "file" [name|@line] | candidates | review id | apply id reviewToken | reject id';

interface ConductState {
  version: 1;
  enabled: boolean;
  model?: string;
  advisorModel?: string;
}

interface ActiveRun {
  phase: "worker" | "capture";
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
  return {
    version: 1,
    enabled: data.enabled,
    model: "model" in data && typeof data.model === "string" ? data.model : undefined,
    advisorModel:
      "advisorModel" in data && typeof data.advisorModel === "string"
        ? data.advisorModel
        : undefined,
  };
}

export default function conductExtension(pi: ExtensionAPI): void {
  let state: ConductState = { version: 1, enabled: false };
  let hasState = false;
  let running: ActiveRun | undefined;
  let selected: MarkerSelection | undefined;
  let selectionEpoch = 0;
  let sessionEpoch = 0;
  let operation = false;
  let retained = false;

  const store = (ctx: ExtensionContext) =>
    path.join(getAgentDir(), "conduct", ctx.sessionManager.getSessionId());
  function assertEpoch(epoch: number): void {
    if (epoch !== sessionEpoch) throw new Error("Session changed; retry in the current session.");
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "conduct",
      state.enabled
        ? `Conduct: on | advisor ${state.advisorModel ?? "off"}${running ? (running.phase === "worker" ? " | worker running" : " | capturing candidate") : ""}`
        : undefined,
    );
  }

  async function syncTool(ctx: ExtensionContext): Promise<void> {
    const active = pi.getActiveTools();
    const owned = [TOOL, SELECT_TOOL, CANDIDATE_TOOL];
    const desired = [
      ...(state.enabled ? [TOOL, SELECT_TOOL] : []),
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
          "No configured loopback model is available. Configure a local model in OMP, then use /conduct model provider/id.",
        );
      if (!ctx.hasUI)
        throw new Error(
          `Choose an exact model with /conduct model provider/id. Available: ${choices.join(", ")}`,
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

  pi.registerCommand("conduct", {
    description: "Prepare protected local-worker candidates; review and explicitly apply them",
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
              throw new Error("Conduct is off. Enable /conduct on before applying.");
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
                    patchLines: view.patch.split(/\r?\n/),
                    approval: view.reviewToken
                      ? `/conduct apply ${view.candidate.id} ${view.reviewToken}`
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
              `Conduct ${state.enabled ? "on" : "off"}. Worker: ${state.model ?? "not selected"}. Advisor: ${state.advisorModel ?? "off"}. ${running ? "Worker running." : "Idle."} ${selected ? `Selected: ${selected.path}:${selected.startLine}-${selected.endLine}.` : "No marker selected."} Protected unapplied candidates; explicit human application; no OS sandbox.`,
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
            selected = selectMarker(
              file,
              selector?.startsWith("@")
                ? { line: Number(selector.slice(1)) }
                : selector === undefined
                  ? {}
                  : { marker: selector },
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
                "Worker still running. Use /conduct off cancel to preserve its partial candidate and disable the mode, or let it finish first. Source targets remain unchanged.",
                "warning",
              );
              return;
            }
            state = { ...state, enabled: false };
            selectionEpoch++;
            selected = undefined;
            persist();
            const outcome = await cancelWorker();
            assertEpoch(epoch);
            await syncTool(ctx);
            assertEpoch(epoch);
            ctx.ui.notify(
              outcome === "ended"
                ? "Conduct off. Worker had already ended; candidate capture finished and the candidate remains available for review and rejection. Nothing was applied."
                : outcome === "cancelled"
                  ? "Conduct off. Worker cancelled; partial candidate retained for inspection. Nothing was applied."
                  : "Conduct off. Retained candidates remain available for review and rejection; nothing was applied.",
              "info",
            );
            return;
          }
          case "cancel": {
            if (rest.length) throw new Error(USAGE);
            if (!running) {
              ctx.ui.notify("No conduct worker is running.", "info");
              return;
            }
            const outcome = await cancelWorker();
            assertEpoch(epoch);
            ctx.ui.notify(
              outcome === "ended"
                ? "Worker had already ended. Candidate capture finished and the candidate was retained for inspection; source targets were not applied."
                : "Worker cancelled. Partial candidate retained for inspection; source targets were not applied.",
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
        throw new Error("Conduct is off. Enable /conduct on before using conduct_select.");
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
        selected = selectMarker(file, {
          marker: params.marker ?? undefined,
          line: params.line ?? undefined,
        });
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
                  patchLines: view.patch.split(/\r?\n/),
                  approval: view.reviewToken
                    ? `/conduct apply ${view.candidate.id} ${view.reviewToken}`
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

  pi.registerTool({
    name: TOOL,
    label: "Conduct worker",
    description: taskDescription,
    defaultInactive: true,
    loadMode: "essential",
    approval: "write",
    parameters: pi.typebox.Type.Object({
      directive: pi.typebox.Type.Optional(
        pi.typebox.Type.Union([pi.typebox.Type.String({ minLength: 1 }), pi.typebox.Type.Null()], {
          description: "Freeform user directive, verbatim; null or omitted when using selection",
        }),
      ),
      selection: pi.typebox.Type.Optional(
        pi.typebox.Type.Union([pi.typebox.Type.String({ minLength: 1 }), pi.typebox.Type.Null()], {
          description:
            "Token from conduct_select or /conduct select; null or omitted when using directive",
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
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!state.enabled)
        throw new Error("Conduct is off. The user must enable /conduct on before dispatch.");
      if (running)
        throw new Error(
          "A conduct worker is already running. Wait for it to finish before dispatching another.",
        );
      if (operation) throw new Error("Another Conduct operation is in progress.");
      if (!Array.isArray(params.files) || !params.files.length)
        throw new Error("Provide files: an explicit nonempty list of exact writable files.");
      if (!state.model) throw new Error("Select a worker with /conduct model provider/id.");
      if ((params.directive == null) === (params.selection == null))
        throw new Error("Provide exactly one of directive or selection.");
      const meaningful = (value: unknown): value is string =>
        typeof value === "string" && value.trim().length > 0;
      if (
        (params.directive != null && !meaningful(params.directive)) ||
        !meaningful(params.assignment)
      )
        throw new Error("Directive and assignment must contain meaningful text.");
      if (
        !meaningful(params.context) ||
        !Array.isArray(params.fixedDecisions) ||
        !params.fixedDecisions.every(meaningful) ||
        !Array.isArray(params.acceptance) ||
        !params.acceptance.length ||
        !params.acceptance.every(meaningful)
      )
        throw new Error("Provide meaningful context, fixedDecisions, and nonempty acceptance.");
      const chosen = params.selection == null ? undefined : selected;
      if (params.selection != null && (!chosen || chosen.id !== params.selection))
        throw new Error("Unknown or expired selection. Reselect the directive before dispatch.");
      const model = resolveLocalModel(ctx, state.model);
      if (state.advisorModel) resolveAdvisorModel(ctx, state.advisorModel);
      const controller = new AbortController();
      const { promise: done, resolve: finish } = Promise.withResolvers<void>();
      const active: ActiveRun = { phase: "worker", controller, done, finish };
      running = active;
      selectionEpoch++;
      updateStatus(ctx);
      const epoch = sessionEpoch;
      const storeDir = store(ctx);
      let prepared: PreparedCandidate | undefined;
      let finalizationStarted = false;
      const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        runSignal.throwIfAborted();
        const directive = chosen ? await verifySelection(chosen) : params.directive!;
        runSignal.throwIfAborted();
        assertEpoch(epoch);
        prepared = await prepareCandidate({
          cwd: ctx.cwd,
          storeDir,
          files: params.files,
          directive,
          assignment: params.assignment,
          brief: {
            context: params.context,
            fixedDecisions: params.fixedDecisions,
            acceptance: params.acceptance,
            model: `${model.provider}/${model.id}`,
            advisorModel: state.advisorModel,
          },
        });
        retained = true;
        assertEpoch(epoch);
        runSignal.throwIfAborted();
        let sourcePath: string | undefined;
        if (chosen) {
          const source = path.relative(prepared.candidate.root, chosen.realPath);
          if (source === ".." || source.startsWith(`..${path.sep}`) || path.isAbsolute(source))
            throw new Error(
              "Selected source is outside the candidate repository; select a repository source.",
            );
          const bytes = await Bun.file(path.join(prepared.worktree, source)).arrayBuffer();
          assertEpoch(epoch);
          if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== chosen.digest)
            throw new Error(
              "Selected source snapshot mismatch; reselect and review before dispatch.",
            );
          sourcePath = path.relative(prepared.workerCwd, path.join(prepared.worktree, source));
        }
        const { workerCwd, worktree } = prepared;
        const assignment = renderMarkerAssignment({
          path: sourcePath,
          startLine: chosen?.startLine,
          endLine: chosen?.endLine,
          assignment: params.assignment,
          root: prepared.worktree,
          cwd: prepared.workerCwd,
          files: prepared.candidate.files.map((file) => JSON.stringify(file)),
          cwdFiles: prepared.candidate.files.map((file) =>
            JSON.stringify(path.relative(workerCwd, path.join(worktree, file))),
          ),
        });
        runSignal.throwIfAborted();
        const result = await runWorker({
          ctx,
          worktree: prepared.workerCwd,
          root: prepared.worktree,
          files: [...prepared.candidate.files],
          brief: prepared.candidate.brief!,
          model,
          directive,
          assignment,
          signal: runSignal,
          onProgress: (progress) =>
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Local worker ${progress.status}; advisor ${prepared!.candidate.brief!.advisorModel ?? "off"}; ${progress.toolCount} tool calls${progress.currentTool ? `; ${progress.currentTool}` : ""}.`,
                },
              ],
              details: {
                status: progress.status,
                model: progress.resolvedModel,
                advisorModel: prepared!.candidate.brief!.advisorModel,
              },
            }),
        });
        active.phase = "capture";
        finalizationStarted = true;
        updateStatus(ctx);
        const candidate = await finishCandidate(prepared, {
          status:
            result.aborted || runSignal.aborted
              ? "cancelled"
              : result.exitCode === 0
                ? "completed"
                : "failed",
          model: result.resolvedModel,
          id: result.id,
          outputPath: result.outputPath,
          error: result.error,
        });
        assertEpoch(epoch);
        return {
          content: [
            {
              type: "text",
              text: [
                `Candidate ${candidate.id}: ${candidate.status}. Patch: ${candidate.patchPath}. Model: ${result.resolvedModel ?? state.model}.`,
                result.output,
                result.error,
                result.stderr,
                "Nothing was applied. Inspect the candidate's actual patch with conduct_candidate, review behavior, then ask the human to run the exact /conduct apply command with its returned review token. Worker reports are not verification.",
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
          details: {
            candidate,
            status: candidate.status,
            model: result.resolvedModel,
            id: result.id,
            outputPath: result.outputPath,
          },
          isError: candidate.status !== "ready",
        };
      } catch (error) {
        active.phase = "capture";
        if (prepared && !finalizationStarted) {
          updateStatus(ctx);
          await finishCandidate(prepared, {
            status: runSignal.aborted ? "cancelled" : "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      } finally {
        if (running === active) running = undefined;
        active.finish();
        if (epoch === sessionEpoch) await syncTool(ctx);
      }
    },
  });
}
