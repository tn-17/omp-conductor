import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
  type AgentSession,
  type SingleResult,
} from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { runAssignments, type ConductAssignment } from "../batch";
import * as workers from "../worker";
import * as reviewers from "../reviewer";
import * as verification from "../verification";
import type { ReviewFinding } from "../review-types";
import * as candidates from "../candidates";
import { readMarkerFile, selectMarker } from "../selection";

const sessions: AgentSession[] = [];
const directories: string[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const session of sessions.splice(0)) await session.dispose();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-batch-"));
  directories.push(directory);
  const root = path.join(directory, "repo");
  await fs.mkdir(root);
  await Bun.write(path.join(root, "a.ts"), "export const a = 1;\n");
  await Bun.write(path.join(root, "b.ts"), "export const b = 1;\n");
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
  ]) {
    const result = Bun.spawnSync(["git", "-C", root, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  const registry = new ModelRegistry(
    await discoverAuthStorage(directory),
    path.join(directory, "models.json"),
  );
  registry.registerProvider("batch-test", {
    baseUrl: "http://127.0.0.1:1/v1",
    api: "openai-completions",
    apiKey: "test-only",
    models: [
      {
        id: "worker",
        name: "Worker",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 4096,
      },
    ],
  });
  const model = registry.find("batch-test", "worker")!;
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: directory,
    modelRegistry: registry,
    model,
    sessionManager: SessionManager.create(root, path.join(directory, "sessions")),
    settings: Settings.isolated({
      "memory.backend": "off",
      "advisor.enabled": false,
      "autolearn.enabled": false,
    }),
    disableExtensionDiscovery: true,
    extensions: [() => {}],
    skills: [],
    contextFiles: [],
    rules: [],
    promptTemplates: [],
    slashCommands: [],
    enableMCP: false,
    enableLsp: false,
    skipPythonPreflight: true,
    toolNames: ["read"],
  });
  sessions.push(session);
  await initializeExtensions(session, {
    reportSendError: (_action, error) => {
      throw error;
    },
    reportRuntimeError: (error) => {
      throw new Error(error.error);
    },
  });
  const controller = new AbortController();
  const assignments: ConductAssignment[] = ["a.ts", "b.ts"].map((file) => ({
    directive: `Change ${file}.`,
    files: [file],
    assignment: `Implement ${file}.`,
    context: "Independent modules.",
    fixedDecisions: [],
    acceptance: ["Export value 2."],
  }));
  const input = {
    ctx: session.extensionRunner!.createContext(),
    storeDir: path.join(directory, "store"),
    assignments,
    model,
    signal: controller.signal,
    onPrepared: () => {},
    onPhase: (_phase: "worker" | "capture") => {},
    onProgress: () => {},
  };
  return { root, controller, input };
}

function result(aborted = false): SingleResult {
  return {
    index: 0,
    id: "controlled-worker",
    agent: "conduct-worker",
    agentSource: "project",
    task: "fixture",
    exitCode: aborted ? 1 : 0,
    output: "",
    stderr: "",
    truncated: false,
    durationMs: 0,
    tokens: 0,
    requests: 0,
    aborted,
    resolvedModel: "batch-test/worker",
  };
}

const finding: ReviewFinding = {
  id: "wrong-value",
  file: "a.ts",
  line: 1,
  severity: "medium",
  title: "Wrong value",
  evidence: "Value is 2",
  expected: "Export value 3",
};

test("review findings drive a fresh correction and clean cumulative review before readiness", async () => {
  const { input, root } = await fixture();
  input.assignments = input.assignments.slice(0, 1);
  let calls = 0;
  const worker = spyOn(workers, "runWorker").mockImplementation(async (request) => {
    calls++;
    if (calls === 2) expect(request.assignment).toContain("wrong-value");
    await Bun.write(path.join(request.root, "a.ts"), `export const a = ${calls + 1};\n`);
    return result();
  });
  const reviewer = spyOn(reviewers, "runReviewer").mockImplementation(async (request) => {
    expect(request.patch).toContain("-export const a = 1;");
    expect(request.patch).toContain(`+export const a = ${request.pass + 1};`);
    if (request.pass === 2)
      expect(request.previous[0]!.review!.findings[0]!.id).toBe("wrong-value");
    return {
      result: result(),
      report: { summary: "Review complete", findings: request.pass === 1 ? [finding] : [] },
    };
  });
  restores.push(
    () => worker.mockRestore(),
    () => reviewer.mockRestore(),
  );
  const [entry] = await runAssignments({ ...input, reviewerModel: "batch-test/worker" });
  expect(entry!.details.status).toBe("ready");
  expect(calls).toBe(2);
  const retained = await candidates.inspectCandidate(
    input.storeDir,
    root,
    entry!.details.candidate.id,
  );
  expect(retained.patch).toContain("+export const a = 3;");
  expect(retained.candidate.review?.status).toBe("clean");
  expect(retained.candidate.review?.passes.map((pass) => pass.review?.findings.length)).toEqual([
    1, 0,
  ]);
  expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("export const a = 1;\n");
});

test("review pass cap retains needs-attention and refuses human application", async () => {
  const { input, root } = await fixture();
  input.assignments = input.assignments.slice(0, 1);
  const worker = spyOn(workers, "runWorker").mockImplementation(async (request) => {
    await Bun.write(path.join(request.root, "a.ts"), "export const a = 2;\n");
    return result();
  });
  const reviewer = spyOn(reviewers, "runReviewer").mockImplementation(async () => ({
    result: result(),
    report: { summary: "Still wrong", findings: [finding] },
  }));
  restores.push(
    () => worker.mockRestore(),
    () => reviewer.mockRestore(),
  );
  const [entry] = await runAssignments({
    ...input,
    reviewerModel: "batch-test/worker",
    reviewPasses: 2,
  });
  expect(entry!.details.status).toBe("needs-attention");
  expect(worker).toHaveBeenCalledTimes(2);
  expect(reviewer).toHaveBeenCalledTimes(2);
  const view = await candidates.inspectCandidate(input.storeDir, root, entry!.details.candidate.id);
  expect(view.candidate.review?.passes).toHaveLength(2);
  await expect(
    candidates.applyCandidate(input.storeDir, root, view.candidate.id, view.reviewToken ?? ""),
  ).rejects.toThrow();
});

test("empty review findings cannot override failed configured verification", async () => {
  const { input } = await fixture();
  input.assignments = input.assignments.slice(0, 1);
  const worker = spyOn(workers, "runWorker").mockImplementation(async (request) => {
    await Bun.write(path.join(request.root, "a.ts"), "export const a = 2;\n");
    return result();
  });
  const reviewer = spyOn(reviewers, "runReviewer").mockImplementation(async () => ({
    result: result(),
    report: { summary: "No code findings", findings: [] },
  }));
  const verify = spyOn(verification, "runVerification").mockImplementation(async () => ({
    argv: ["false"],
    status: "failed",
    exitCode: 1,
    output: "assertion failed",
    truncated: false,
    durationMs: 1,
  }));
  restores.push(
    () => worker.mockRestore(),
    () => reviewer.mockRestore(),
    () => verify.mockRestore(),
  );
  const [entry] = await runAssignments({
    ...input,
    reviewerModel: "batch-test/worker",
    reviewPasses: 2,
    verification: { argv: ["false"], timeoutMs: 120000 },
  });
  expect(entry!.details.status).toBe("needs-attention");
  expect(entry!.details.candidate.review?.passes.map((pass) => pass.verification?.status)).toEqual([
    "failed",
    "failed",
  ]);
  expect(worker).toHaveBeenCalledTimes(2);
});

test("verification without reviewer runs once and does not launch corrections", async () => {
  const { input } = await fixture();
  input.assignments = input.assignments.slice(0, 1);
  const worker = spyOn(workers, "runWorker").mockImplementation(async (request) => {
    await Bun.write(path.join(request.root, "a.ts"), "export const a = 2;\n");
    return result();
  });
  const reviewer = spyOn(reviewers, "runReviewer");
  const verify = spyOn(verification, "runVerification").mockImplementation(async () => ({
    argv: ["false"],
    status: "failed",
    exitCode: 1,
    output: "failure",
    truncated: false,
    durationMs: 1,
  }));
  restores.push(
    () => worker.mockRestore(),
    () => reviewer.mockRestore(),
    () => verify.mockRestore(),
  );
  const [entry] = await runAssignments({
    ...input,
    verification: { argv: ["false"], timeoutMs: 120000 },
  });
  expect(entry!.details.status).toBe("needs-attention");
  expect(worker).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(reviewer).not.toHaveBeenCalled();
});

test("cancelled correction retains the preceding review and verification evidence", async () => {
  const { input, controller, root } = await fixture();
  input.assignments = input.assignments.slice(0, 1);
  let calls = 0;
  const worker = spyOn(workers, "runWorker").mockImplementation(async (request) => {
    if (++calls === 2) {
      controller.abort();
      return result(true);
    }
    await Bun.write(path.join(request.root, "a.ts"), "export const a = 2;\n");
    return result();
  });
  const reviewer = spyOn(reviewers, "runReviewer").mockImplementation(async () => ({
    result: result(),
    report: { summary: "Needs correction", findings: [finding] },
  }));
  const verify = spyOn(verification, "runVerification").mockImplementation(async () => ({
    argv: ["true"],
    status: "passed",
    exitCode: 0,
    output: "test evidence",
    truncated: false,
    durationMs: 1,
  }));
  restores.push(
    () => worker.mockRestore(),
    () => reviewer.mockRestore(),
    () => verify.mockRestore(),
  );
  const [entry] = await runAssignments({
    ...input,
    reviewerModel: "batch-test/worker",
    verification: { argv: ["true"], timeoutMs: 120000 },
  });
  expect(entry!.details.status).toBe("cancelled");
  const saved = await candidates.load(input.storeDir, root, entry!.details.candidate.id);
  expect(saved.review?.status).toBe("cancelled");
  expect(saved.review?.passes[0]?.verification?.output).toBe("test evidence");
  expect(saved.review?.passes[0]?.review?.findings[0]?.id).toBe("wrong-value");
  expect(saved.review?.passes[1]?.error).toContain("cancelled");
});

test("thrown correction failure is recorded on an explicit correction pass", async () => {
  const { input, root } = await fixture();
  input.assignments = input.assignments.slice(0, 1);
  let calls = 0;
  const worker = spyOn(workers, "runWorker").mockImplementation(async (request) => {
    if (++calls === 2) throw new Error("correction invocation failed");
    await Bun.write(path.join(request.root, "a.ts"), "export const a = 2;\n");
    return result();
  });
  const reviewer = spyOn(reviewers, "runReviewer").mockImplementation(async () => ({
    result: result(),
    report: { summary: "Needs correction", findings: [finding] },
  }));
  restores.push(
    () => worker.mockRestore(),
    () => reviewer.mockRestore(),
  );
  const [entry] = await runAssignments({
    ...input,
    reviewerModel: "batch-test/worker",
    reviewPasses: 2,
  });
  expect(entry!.details.status).toBe("failed");
  const saved = await candidates.load(input.storeDir, root, entry!.details.candidate.id);
  expect(saved.review?.status).toBe("failed");
  expect(saved.review?.passes.map((pass) => pass.pass)).toEqual([1, 2]);
  expect(saved.review?.passes[0]?.review?.findings[0]?.id).toBe("wrong-value");
  expect(saved.review?.passes[0]?.error).toBeUndefined();
  expect(saved.review?.passes[1]?.review).toBeUndefined();
  expect(saved.review?.passes[1]?.error).toContain("correction invocation failed");
});

test("read-only reviewer mutation fails even inside the writable candidate scope", async () => {
  const { input } = await fixture();
  input.assignments = input.assignments.slice(0, 1);
  const worker = spyOn(workers, "runWorker").mockImplementation(async (request) => {
    await Bun.write(path.join(request.root, "a.ts"), "export const a = 2;\n");
    return result();
  });
  const reviewer = spyOn(reviewers, "runReviewer").mockImplementation(async (request) => {
    await Bun.write(path.join(request.root, "a.ts"), "export const a = 99;\n");
    return { result: result(), report: { summary: "Claimed clean", findings: [] } };
  });
  restores.push(
    () => worker.mockRestore(),
    () => reviewer.mockRestore(),
  );
  const [entry] = await runAssignments({ ...input, reviewerModel: "batch-test/worker" });
  expect(entry!.details.status).toBe("failed");
  expect(entry!.details.candidate.error).toContain("reviewer changed");
  expect(entry!.details.candidate.review?.passes[0]?.review?.summary).toBe("Claimed clean");
});

test("trusted verification cannot change the reviewed candidate while claiming a pass", async () => {
  const { input } = await fixture();
  input.assignments = input.assignments.slice(0, 1);
  const worker = spyOn(workers, "runWorker").mockImplementation(async (request) => {
    await Bun.write(path.join(request.root, "a.ts"), "export const a = 2;\n");
    return result();
  });
  const reviewer = spyOn(reviewers, "runReviewer");
  const verify = spyOn(verification, "runVerification").mockImplementation(async (request) => {
    await Bun.write(path.join(request.root, "a.ts"), "export const a = 99;\n");
    return {
      argv: ["true"],
      status: "passed",
      exitCode: 0,
      output: "claimed passed",
      truncated: false,
      durationMs: 1,
    };
  });
  restores.push(
    () => worker.mockRestore(),
    () => reviewer.mockRestore(),
    () => verify.mockRestore(),
  );
  const [entry] = await runAssignments({
    ...input,
    reviewerModel: "batch-test/worker",
    verification: { argv: ["true"], timeoutMs: 120000 },
  });
  expect(entry!.details.status).toBe("failed");
  expect(entry!.details.candidate.error).toContain("changed during verification");
  expect(entry!.details.candidate.review?.passes[0]?.verification?.output).toBe("claimed passed");
  expect(reviewer).not.toHaveBeenCalled();
});

test("malformed reviewer output preserves failure artifacts and never becomes ready", async () => {
  const { input, root } = await fixture();
  input.assignments = input.assignments.slice(0, 1);
  const worker = spyOn(workers, "runWorker").mockImplementation(async (request) => {
    await Bun.write(path.join(request.root, "a.ts"), "export const a = 2;\n");
    return result();
  });
  const reviewer = spyOn(reviewers, "runReviewer").mockImplementation(async () => {
    throw new reviewers.ReviewerError("Invalid review", {
      ...result(),
      id: "invalid-review-id",
      outputPath: "/retained/review",
    });
  });
  restores.push(
    () => worker.mockRestore(),
    () => reviewer.mockRestore(),
  );
  const [entry] = await runAssignments({ ...input, reviewerModel: "batch-test/worker" });
  expect(entry!.details.status).toBe("failed");
  const saved = await candidates.load(input.storeDir, root, entry!.details.candidate.id);
  expect(saved.review?.passes[0]?.error).toContain("Invalid review");
  expect(saved.review?.passes[0]?.reviewer?.outputPath).toBe("/retained/review");
  expect(saved.review?.passes[0]?.reviewer?.id).toBe("invalid-review-id");
});

test("post-save cleanup failure reports the persisted candidate without inventing recovery bytes", async () => {
  const { root, input } = await fixture();
  const snapshots: string[] = [];
  const workerSpy = spyOn(workers, "runWorker").mockImplementation(async (worker) => {
    snapshots.push(worker.root);
    await Bun.write(path.join(worker.root, worker.files[0]!), "export const value = 2;\n");
    return result();
  });
  restores.push(() => workerSpy.mockRestore());
  const remove = fs.rm;
  const removeSpy = spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (String(target).endsWith("/isolation.json")) throw new Error("cleanup-unlink-denied");
    await remove(target, options);
  });
  restores.push(() => removeSpy.mockRestore());
  const results = await runAssignments(input);
  for (const entry of results) {
    const view = await candidates.inspectCandidate(
      input.storeDir,
      root,
      entry.details.candidate.id,
    );
    expect(entry.details.status).toBe(view.candidate.status);
    expect(view.candidate.status).toBe("ready");
    expect(entry.isError).toBe(true);
    expect(entry.content.map((block) => block.text).join("\n")).toContain("cleanup-unlink-denied");
    expect(entry.content.map((block) => block.text).join("\n")).not.toContain("Snapshot retained");
  }
  for (const snapshot of snapshots)
    expect(await fs.stat(snapshot).catch(() => undefined)).toBeUndefined();
});

test("unreadable finalization state is unknown rather than an applicable candidate", async () => {
  const { root, input } = await fixture();
  const workerSpy = spyOn(workers, "runWorker").mockImplementation(async (worker) => {
    await Bun.write(path.join(worker.root, worker.files[0]!), "export const value = 2;\n");
    return result();
  });
  restores.push(() => workerSpy.mockRestore());
  const finish = candidates.finishCandidate;
  const finishSpy = spyOn(candidates, "finishCandidate").mockImplementation(async (...args) => {
    await finish(...args);
    throw new Error("post-save failure");
  });
  restores.push(() => finishSpy.mockRestore());
  const loadSpy = spyOn(candidates, "load").mockImplementation(async () => {
    throw new Error("record unreadable");
  });
  restores.push(() => loadSpy.mockRestore());
  const results = await runAssignments(input);
  loadSpy.mockRestore();
  for (const entry of results) {
    expect(entry.details.status).toBe("unknown");
    expect(entry.isError).toBe(true);
    expect(entry.content.map((block) => block.text).join("\n")).toContain(
      "not confirmed persisted state",
    );
    const view = await candidates.inspectCandidate(
      input.storeDir,
      root,
      entry.details.candidate.id,
    );
    expect(view.candidate.status).toBe("ready");
  }
});

test("workers overlap after all snapshots and results retain input order", async () => {
  const { root, input } = await fixture();
  const bothStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let started = 0;
  const spy = spyOn(workers, "runWorker").mockImplementation(async (worker) => {
    if (++started === 2) bothStarted.resolve();
    await release.promise;
    await Bun.write(path.join(worker.root, worker.files[0]!), "export const value = 2;\n");
    return result();
  });
  restores.push(() => spy.mockRestore());
  const execution = runAssignments(input);
  try {
    await bothStarted.promise;
  } finally {
    release.resolve();
  }
  const results = await execution;
  expect(results.map((value) => value.details.candidate.files)).toEqual([["a.ts"], ["b.ts"]]);
  expect(results.map((value) => value.details.status)).toEqual(["ready", "ready"]);
  expect(await fs.readFile(path.join(root, "a.ts"), "utf8")).toBe("export const a = 1;\n");
  expect(
    (await candidates.listCandidates(input.storeDir, root)).map((value) => value.status),
  ).toEqual(["ready", "ready"]);
});

test("all briefs and canonical scopes preflight before launching any worker", async () => {
  const { root, input } = await fixture();
  const spy = spyOn(workers, "runWorker").mockImplementation(async () => {
    throw new Error("must not launch");
  });
  restores.push(() => spy.mockRestore());
  input.assignments[1]!.context = " ";
  await expect(runAssignments(input)).rejects.toThrow("meaningful context");
  input.assignments[1]!.context = "Valid context";
  input.assignments[1]!.files = [path.join(root, "a.ts")];
  await expect(runAssignments(input)).rejects.toThrow("overlap");
  input.assignments[0]!.files = ["new"];
  input.assignments[1]!.files = ["new/child.ts"];
  await expect(runAssignments(input)).rejects.toThrow("overlap");
  expect(spy).not.toHaveBeenCalled();
  expect(await candidates.listCandidates(input.storeDir, root)).toEqual([]);
});

test("individual worker failure waits for a healthy sibling without cancelling it", async () => {
  const { input } = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let finished = false;
  const spy = spyOn(workers, "runWorker").mockImplementation(async (worker) => {
    if (worker.files[0] === "a.ts") throw new Error("independent failure");
    started.resolve();
    await release.promise;
    expect(worker.signal.aborted).toBe(false);
    await Bun.write(path.join(worker.root, "b.ts"), "export const b = 2;\n");
    return result();
  });
  restores.push(() => spy.mockRestore());
  const execution = runAssignments(input).then((value) => {
    finished = true;
    return value;
  });
  try {
    await started.promise;
    expect(finished).toBe(false);
  } finally {
    release.resolve();
  }
  const results = await execution;
  expect(results.map((value) => value.details.status)).toEqual(["failed", "ready"]);
  expect(results[0]!.details.candidate.error).toContain("independent failure");
});

test("cancel waits unfinished workers while preserving an already completed sibling", async () => {
  const { root, controller, input } = await fixture();
  const complete = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let finished = false;
  const spy = spyOn(workers, "runWorker").mockImplementation(async (worker) => {
    if (worker.files[0] === "a.ts") {
      await Bun.write(path.join(worker.root, "a.ts"), "export const a = 2;\n");
      complete.resolve();
      return result();
    }
    started.resolve();
    await release.promise;
    return result(worker.signal.aborted);
  });
  restores.push(() => spy.mockRestore());
  const execution = runAssignments(input).then((value) => {
    finished = true;
    return value;
  });
  try {
    await Promise.all([complete.promise, started.promise]);
    await Promise.resolve();
    controller.abort();
    expect(finished).toBe(false);
  } finally {
    release.resolve();
  }
  const results = await execution;
  expect(results.map((value) => value.details.status)).toEqual(["ready", "cancelled"]);
  for (const entry of results) {
    const isolation = path.join(input.storeDir, entry.details.candidate.id, "isolation.json");
    expect(await Bun.file(isolation).exists()).toBe(false);
  }
  expect(
    (await candidates.listCandidates(input.storeDir, root)).some(
      (value) => value.status === "running",
    ),
  ).toBe(false);
});

test("abort during preparation cleans every snapshot and never launches", async () => {
  const { root, controller, input } = await fixture();
  const prepare = candidates.prepareCandidate;
  const snapshots: string[] = [];
  const spy = spyOn(candidates, "prepareCandidate").mockImplementation(async (args) => {
    const snapshot = await prepare(args);
    snapshots.push(snapshot.worktree);
    if (args.files[0] === "b.ts") controller.abort();
    return snapshot;
  });
  const worker = spyOn(workers, "runWorker").mockImplementation(async () => {
    throw new Error("must not launch");
  });
  restores.push(
    () => spy.mockRestore(),
    () => worker.mockRestore(),
  );
  await expect(runAssignments(input)).rejects.toThrow();
  expect(worker).not.toHaveBeenCalled();
  expect(
    (await candidates.listCandidates(input.storeDir, root)).map((value) => value.status),
  ).toEqual(["cancelled", "cancelled"]);
  for (const snapshot of snapshots)
    await expect(fs.stat(snapshot)).rejects.toMatchObject({ code: "ENOENT" });
});

test("late snapshot mismatch finalizes every prepared candidate without dispatch", async () => {
  const { root, input } = await fixture();
  await Bun.write(path.join(root, "marker.ts"), "// OMP-CONDUCT: Change b.\n");
  const selection = selectMarker(await readMarkerFile(root, "marker.ts"));
  input.assignments[1]!.directive = undefined;
  input.assignments[1]!.selection = selection;
  const prepare = candidates.prepareCandidate;
  const spy = spyOn(candidates, "prepareCandidate").mockImplementation(async (args) => {
    const snapshot = await prepare(args);
    if (args.files[0] === "b.ts")
      await Bun.write(path.join(snapshot.worktree, "marker.ts"), "changed\n");
    return snapshot;
  });
  const worker = spyOn(workers, "runWorker").mockImplementation(async () => {
    throw new Error("must not launch");
  });
  restores.push(
    () => spy.mockRestore(),
    () => worker.mockRestore(),
  );
  await expect(runAssignments(input)).rejects.toThrow("snapshot mismatch");
  expect(worker).not.toHaveBeenCalled();
  const records = await candidates.listCandidates(input.storeDir, root);
  expect(records.map((value) => value.status)).toEqual(["failed", "failed"]);
  expect(await Bun.file(path.join(input.storeDir, records[0]!.id, "isolation.json")).exists()).toBe(
    false,
  );
});
