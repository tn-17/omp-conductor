import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type { AgentProgress, ExtensionContext, SingleResult } from "@oh-my-pi/pi-coding-agent";
import { prompt } from "@oh-my-pi/pi-utils";
import {
  finishCandidate,
  load,
  prepareCandidate,
  resolveCandidateScope,
  type CandidateRecord,
  type PreparedCandidate,
} from "./candidates";
import { verifySelection, type MarkerSelection } from "./selection";
import { resolveAdvisorModel, resolveLocalModel, runWorker } from "./worker";
import markerAssignmentTemplate from "./prompts/marker-assignment.md" with { type: "text" };

const renderMarkerAssignment = prompt.compile(markerAssignmentTemplate);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const meaningful = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export interface ConductAssignment {
  directive?: string;
  selection?: MarkerSelection;
  files: string[];
  assignment: string;
  context: string;
  fixedDecisions: string[];
  acceptance: string[];
}

export interface AssignmentResult {
  content: { type: "text"; text: string }[];
  details: {
    candidate: CandidateRecord;
    status: CandidateRecord["status"] | "unknown";
    model?: string;
    id?: string;
    outputPath?: string;
  };
  isError: boolean;
}

type Outcome = Parameters<typeof finishCandidate>[1];

export async function runAssignments(input: {
  ctx: ExtensionContext;
  storeDir: string;
  assignments: ConductAssignment[];
  model: Model;
  advisorModel?: string;
  workerFast?: boolean;
  advisorFast?: boolean;
  signal: AbortSignal;
  onPrepared: () => void;
  onPhase: (phase: "worker" | "capture") => void;
  onProgress: (index: number, progress: AgentProgress) => void;
}): Promise<AssignmentResult[]> {
  const { signal, ctx } = input;
  const selector = `${input.model.provider}/${input.model.id}`;
  const prepared: PreparedCandidate[] = [];
  const rendered: string[] = [];
  const directives: string[] = [];
  try {
    signal.throwIfAborted();
    if (
      !Array.isArray(input.assignments) ||
      !input.assignments.length ||
      input.assignments.length > 8
    )
      throw new Error("Conduct batches require between 1 and 8 assignments.");
    resolveLocalModel(ctx, selector);
    if (input.advisorModel !== undefined) resolveAdvisorModel(ctx, input.advisorModel);
    const scopes: string[] = [];
    for (const task of input.assignments) {
      signal.throwIfAborted();
      if ((task.directive == null) === (task.selection == null))
        throw new Error("Provide exactly one of directive or selection.");
      if ((task.directive != null && !meaningful(task.directive)) || !meaningful(task.assignment))
        throw new Error("Directive and assignment must contain meaningful text.");
      if (
        !meaningful(task.context) ||
        !Array.isArray(task.fixedDecisions) ||
        !task.fixedDecisions.every(meaningful) ||
        !Array.isArray(task.acceptance) ||
        !task.acceptance.length ||
        !task.acceptance.every(meaningful)
      )
        throw new Error("Provide meaningful context, fixedDecisions, and nonempty acceptance.");
      const directive = task.selection ? await verifySelection(task.selection) : task.directive!;
      if (!meaningful(directive)) throw new Error("Directive must contain meaningful text.");
      directives.push(directive);
      const scope = await resolveCandidateScope(ctx.cwd, task.files);
      const absolute = scope.files.map((file) => path.join(scope.root, file));
      for (const file of absolute) {
        if (
          scopes.some(
            (other) =>
              file === other ||
              file.startsWith(`${other}${path.sep}`) ||
              other.startsWith(`${file}${path.sep}`),
          )
        )
          throw new Error(`Conduct batch writable scopes overlap: ${file}`);
      }
      scopes.push(...absolute);
    }
    for (const [index, task] of input.assignments.entries()) {
      signal.throwIfAborted();
      const snapshot = await prepareCandidate({
        cwd: ctx.cwd,
        storeDir: input.storeDir,
        files: task.files,
        directive: directives[index]!,
        assignment: task.assignment,
        brief: {
          context: task.context,
          fixedDecisions: task.fixedDecisions,
          acceptance: task.acceptance,
          model: selector,
          advisorModel: input.advisorModel,
          workerFast: input.workerFast === true,
          advisorFast: input.advisorFast === true,
        },
      });
      prepared.push(snapshot);
      if (prepared.length === 1) input.onPrepared();
      signal.throwIfAborted();
      let sourcePath: string | undefined;
      if (task.selection) {
        await verifySelection(task.selection);
        const source = path.relative(snapshot.candidate.root, task.selection.realPath);
        if (source === ".." || source.startsWith(`..${path.sep}`) || path.isAbsolute(source))
          throw new Error(
            "Selected source is outside the candidate repository; select a repository source.",
          );
        const bytes = await Bun.file(path.join(snapshot.worktree, source)).arrayBuffer();
        if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== task.selection.digest)
          throw new Error(
            "Selected source snapshot mismatch; reselect and review before dispatch.",
          );
        sourcePath = path.relative(snapshot.workerCwd, path.join(snapshot.worktree, source));
      }
      rendered.push(
        renderMarkerAssignment({
          path: sourcePath,
          startLine: task.selection?.startLine,
          endLine: task.selection?.endLine,
          assignment: task.assignment,
          root: snapshot.worktree,
          cwd: snapshot.workerCwd,
          files: snapshot.candidate.files.map((file) => JSON.stringify(file)),
          cwdFiles: snapshot.candidate.files.map((file) =>
            JSON.stringify(path.relative(snapshot.workerCwd, path.join(snapshot.worktree, file))),
          ),
        }),
      );
    }
    // Earlier selections may change while a later snapshot is being prepared.
    for (const task of input.assignments) {
      if (task.selection) await verifySelection(task.selection);
    }
    signal.throwIfAborted();
  } catch (error) {
    input.onPhase("capture");
    const cleanup = await Promise.allSettled(
      prepared.map((snapshot) =>
        finishCandidate(snapshot, {
          status: signal.aborted ? "cancelled" : "failed",
          error: message(error),
        }),
      ),
    );
    const failures = cleanup.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        [error, ...failures.map((result) => result.reason)],
        "Conduct preflight and candidate finalization failed",
      );
    throw error;
  }

  input.onPhase("worker");
  // Each continuation pins its outcome before any asynchronous capture or sibling cancellation.
  const settled = await Promise.all(
    prepared.map(async (snapshot, index): Promise<{ outcome: Outcome; result?: SingleResult }> => {
      try {
        const result = await runWorker({
          ctx,
          model: input.model,
          worktree: snapshot.workerCwd,
          root: snapshot.worktree,
          files: [...snapshot.candidate.files],
          brief: snapshot.candidate.brief!,
          directive: directives[index]!,
          assignment: rendered[index]!,
          signal,
          onProgress: (progress) => input.onProgress(index, progress),
        });
        return {
          result,
          outcome: {
            status: result.aborted ? "cancelled" : result.exitCode === 0 ? "completed" : "failed",
            model: result.resolvedModel,
            id: result.id,
            outputPath: result.outputPath,
            error: result.error,
          },
        };
      } catch (error) {
        return {
          outcome: { status: signal.aborted ? "cancelled" : "failed", error: message(error) },
        };
      }
    }),
  );
  input.onPhase("capture");
  return Promise.all(
    prepared.map(async (snapshot, index): Promise<AssignmentResult> => {
      const { outcome, result } = settled[index]!;
      let candidate: CandidateRecord;
      let finalizationError: string | undefined;
      let stateKnown = true;
      try {
        candidate = await finishCandidate(snapshot, outcome);
      } catch (error) {
        finalizationError = `Candidate finalization failed: ${message(error)}`;
        // Cleanup can fail after a ready record was committed. Never replace
        // its authoritative status with an unpersisted failure or infer that
        // the snapshot still exists.
        try {
          candidate = await load(snapshot.storeDir, ctx.cwd, snapshot.candidate.id);
        } catch (readError) {
          candidate = snapshot.candidate;
          stateKnown = false;
          finalizationError += `; persisted state unavailable: ${message(readError)}. Candidate details are the last in-memory record, not confirmed persisted state.`;
        }
      }
      const status = stateKnown ? candidate.status : "unknown";
      return {
        content: [
          {
            type: "text",
            text: [
              `Candidate ${candidate.id}: ${status}. Patch: ${candidate.patchPath}. Model: ${outcome.model ?? selector}.`,
              finalizationError,
              result?.output,
              candidate.error,
              result?.stderr,
              "Nothing was applied. Inspect the candidate's actual patch with conduct_candidate, review behavior, then ask the human to run the exact /conduct apply command with its returned review token. Worker reports are not verification.",
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        details: {
          candidate,
          status,
          model: outcome.model,
          id: outcome.id,
          outputPath: outcome.outputPath,
        },
        isError: finalizationError !== undefined || candidate.status !== "ready",
      };
    }),
  );
}
