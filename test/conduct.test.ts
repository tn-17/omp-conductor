import { afterEach, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  type AgentSession,
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
  type SingleResult,
} from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import * as codingAgent from "@oh-my-pi/pi-coding-agent";
import * as workers from "../worker";
import * as candidates from "../candidates";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import conductExtension from "../index";

const sessions: AgentSession[] = [];
const directories: string[] = [];
const restores: (() => void)[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.dispose();
  for (const restore of restores.splice(0)) restore();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function openSession(manager?: SessionManager, settings?: Settings): Promise<AgentSession> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-test-"));
  directories.push(directory);
  const cwd = manager?.getCwd() ?? directory;
  if (!manager) {
    const init = Bun.spawnSync(["git", "init", "--quiet", cwd]);
    if (init.exitCode !== 0) throw new Error(init.stderr.toString());
    await Bun.write(path.join(cwd, "target.ts"), "export const value = 1;\n");
    const add = Bun.spawnSync(["git", "-C", cwd, "add", "target.ts"]);
    if (add.exitCode !== 0) throw new Error(add.stderr.toString());
    const commit = Bun.spawnSync([
      "git",
      "-C",
      cwd,
      "-c",
      "user.name=Conduct Test",
      "-c",
      "user.email=conduct@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    if (commit.exitCode !== 0) throw new Error(commit.stderr.toString());
  }
  const registry = new ModelRegistry(
    await discoverAuthStorage(directory),
    path.join(directory, "models.json"),
  );
  const model = {
    id: "worker",
    name: "Worker",
    reasoning: false,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  };
  registry.registerProvider("conduct-test", {
    baseUrl: "http://127.0.0.1:1/v1",
    api: "openai-completions",
    apiKey: "test-only",
    models: [model],
  });
  registry.registerProvider("conduct-cloud", {
    baseUrl: "https://example.com/v1",
    api: "openai-completions",
    apiKey: "test-only",
    models: [model],
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir: directory,
    modelRegistry: registry,
    model: registry.find("conduct-test", "worker"),
    sessionManager: manager ?? SessionManager.create(directory, path.join(directory, "sessions")),
    settings:
      settings ??
      Settings.isolated({
        "memory.backend": "off",
        "advisor.enabled": false,
        "autolearn.enabled": false,
      }),
    disableExtensionDiscovery: true,
    extensions: [conductExtension],
    skills: [],
    contextFiles: [],
    rules: [],
    promptTemplates: [],
    slashCommands: [],
    enableMCP: false,
    enableLsp: false,
    skipPythonPreflight: true,
    toolNames: ["read", "grep"],
  });
  sessions.push(session);
  directories.push(path.join(getAgentDir(), "conduct", session.sessionManager.getSessionId()));
  await initializeExtensions(session, {
    reportSendError: (_action, error) => {
      throw error;
    },
    reportRuntimeError: (error) => {
      throw new Error(error.error);
    },
  });
  return session;
}

async function command(session: AgentSession, args: string): Promise<void> {
  const runner = session.extensionRunner!;
  const registered = runner.getCommand("conduct")!;
  await registered.handler(args, runner.createCommandContext());
}

test("mode restores from disk without leaking to another session", async () => {
  const session = await openSession();
  await command(session, "model conduct-test/worker");
  await command(session, "on");
  expect(session.getActiveToolNames()).toContain("conduct_task");
  const independent = await openSession();
  expect(independent.getActiveToolNames()).not.toContain("conduct_task");
  const manager = session.sessionManager;
  await manager.ensureOnDisk();
  await manager.flush();
  const sessionFile = manager.getSessionFile()!;
  await session.dispose();
  sessions.splice(sessions.indexOf(session), 1);
  const resumed = await openSession(await SessionManager.open(sessionFile));
  expect(resumed.getActiveToolNames()).toContain("conduct_task");
  await command(resumed, "off");
  expect(resumed.getActiveToolNames()).not.toContain("conduct_task");
  expect(resumed.getEnabledToolNames()).toContain("read");
});

test("turning off preserves tools enabled by another component", async () => {
  const session = await openSession();
  await command(session, "model conduct-test/worker");
  await command(session, "on");
  await session.setActiveToolsByName([...session.getEnabledToolNames(), "grep"]);
  await command(session, "off");
  expect(session.getEnabledToolNames()).toContain("grep");
  expect(session.getEnabledToolNames()).not.toContain("conduct_task");
});

test("model selection rejects cloud and fuzzy selectors without replacing the selected worker", async () => {
  const session = await openSession();
  const ctx = session.extensionRunner!.createContext();
  expect(() => workers.resolveLocalModel(ctx, "conduct-cloud/worker")).toThrow("loopback");
  expect(() => workers.resolveLocalModel(ctx, "worker")).toThrow("exact");
  await command(session, "model conduct-test/worker");
  await command(session, "model conduct-cloud/worker");
  await command(session, "on");
  const entries = session.sessionManager.getBranch();
  const state = entries
    .filter((entry) => entry.type === "custom" && entry.customType === "conduct-state")
    .at(-1);
  expect(state && state.type === "custom" && state.data).toMatchObject({
    enabled: true,
    model: "conduct-test/worker",
  });
});

function savedState(session: AgentSession): unknown {
  const entry = session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "conduct-state")
    .at(-1);
  return entry?.type === "custom" ? entry.data : undefined;
}

test("fast preferences are explicit, independent, and persist across off and resume", async () => {
  const settings = Settings.isolated({
    "memory.backend": "off",
    "advisor.enabled": false,
    "autolearn.enabled": false,
    "tier.openai": "priority",
    "tier.subagent": "priority",
    "tier.advisor": "priority",
  });
  const session = await openSession(undefined, settings);
  await command(session, "model conduct-test/worker");
  expect(savedState(session)).toMatchObject({ workerFast: false, advisorFast: false });
  await command(session, "fast worker on");
  await command(session, "fast advisor on");
  await command(session, "fast worker off");
  expect(savedState(session)).toMatchObject({ workerFast: false, advisorFast: true });
  const beforeReports = savedState(session);
  for (const args of [
    "fast",
    "fast worker",
    "fast advisor",
    "fast on",
    "fast worker toggle",
    "fast advisor on extra",
  ]) {
    await command(session, args);
    expect(savedState(session)).toEqual(beforeReports);
  }
  await command(session, "advisor conduct-cloud/worker");
  await command(session, "advisor off");
  await command(session, "model conduct-test/worker");
  await command(session, "on");
  await command(session, "off");
  expect(savedState(session)).toMatchObject({
    enabled: false,
    workerFast: false,
    advisorFast: true,
  });
  expect(settings.get("tier.openai")).toBe("priority");
  expect(settings.get("tier.subagent")).toBe("priority");
  expect(settings.get("tier.advisor")).toBe("priority");
  expect(settings.get("advisor.enabled")).toBe(false);
  const manager = session.sessionManager;
  await manager.ensureOnDisk();
  await manager.flush();
  const sessionFile = manager.getSessionFile()!;
  await session.dispose();
  sessions.splice(sessions.indexOf(session), 1);
  const resumed = await openSession(await SessionManager.open(sessionFile));
  await command(resumed, "on");
  expect(savedState(resumed)).toMatchObject({ workerFast: false, advisorFast: true });
  expect(savedState(resumed)).not.toHaveProperty("advisorModel", expect.any(String));
  await command(resumed, "fast advisor off");
  expect(savedState(resumed)).toMatchObject({ workerFast: false, advisorFast: false });
});

test("old state defaults fast off and malformed fast restores cannot override it", async () => {
  const session = await openSession();
  session.sessionManager.appendCustomEntry("conduct-state", {
    version: 1,
    enabled: false,
    model: "conduct-test/worker",
  });
  session.sessionManager.appendCustomEntry("conduct-state", {
    version: 1,
    enabled: false,
    model: "conduct-test/worker",
    workerFast: "on",
    advisorFast: true,
  });
  session.sessionManager.appendCustomEntry("conduct-state", {
    version: 1,
    enabled: false,
    model: "conduct-test/worker",
    workerFast: true,
    advisorFast: 1,
  });
  for (const workers of [0, 9, 1.5, "2"]) {
    session.sessionManager.appendCustomEntry("conduct-state", {
      version: 1,
      enabled: false,
      model: "conduct-test/worker",
      workerFast: true,
      workers,
    });
  }
  await session.extensionRunner!.emit({ type: "session_start" });
  await command(session, "on");
  expect(savedState(session)).toMatchObject({ workers: 1, workerFast: false, advisorFast: false });
});

test("worker limit is explicit, bounded, restored, and admits batches only when configured", async () => {
  const session = await openSession();
  await command(session, "model conduct-test/worker");
  await command(session, "on");
  const batch = session.getToolByName("conduct_batch")!;
  const task = {
    directive: "Change target",
    assignment: "Change only the owned file",
    context: "Independent constant exports",
    fixedDecisions: [],
    acceptance: ["Exported value is two"],
    files: ["target.ts"],
  };
  await expect(
    batch.execute("default-limit", { tasks: [task, { ...task, files: ["other.ts"] }] }),
  ).rejects.toThrow("worker limit");
  await command(session, "workers 2");
  const configured = savedState(session);
  for (const value of ["", "0", "9", "1.5", "02", "+2", "2e0", "2 extra"]) {
    await command(session, `workers ${value}`);
    expect(savedState(session)).toEqual(configured);
  }
  await expect(batch.execute("empty", { tasks: [] })).rejects.toThrow();
  await expect(
    batch.execute("hard-cap", { tasks: Array.from({ length: 9 }, () => task) }),
  ).rejects.toThrow();
  await command(session, "off");
  const manager = session.sessionManager;
  await manager.ensureOnDisk();
  await manager.flush();
  const sessionFile = manager.getSessionFile()!;
  await session.dispose();
  sessions.splice(sessions.indexOf(session), 1);
  const resumed = await openSession(await SessionManager.open(sessionFile));
  await command(resumed, "on");
  expect(savedState(resumed)).toMatchObject({ workers: 2 });
  await expect(
    resumed.getToolByName("conduct_batch")!.execute("restored-limit", {
      tasks: [task, { ...task, files: ["other.ts"] }, { ...task, files: ["third.ts"] }],
    }),
  ).rejects.toThrow("worker limit");
});

test("batch marker tokens coexist and invocation remains busy through every capture", async () => {
  const session = await openSession();
  await command(session, "model conduct-test/worker");
  await command(session, "workers 2");
  await command(session, "on");
  const cwd = session.extensionRunner!.createContext().cwd;
  const markerFile = path.join(cwd, "directives.ts");
  await Bun.write(
    markerFile,
    "// OMP-CONDUCT BEGIN: first\n// First\n// OMP-CONDUCT END: first\n// OMP-CONDUCT BEGIN: second\n// Second\n// OMP-CONDUCT END: second\n",
  );
  await Bun.write(path.join(cwd, "other.ts"), "export const other = 1;\n");
  const select = session.getToolByName("conduct_select")!;
  const old = selectionToken(
    (await select.execute("old", { path: markerFile, marker: "first" })).details,
  );
  const first = selectionToken(
    (await select.execute("first", { path: markerFile, marker: "first" })).details,
  );
  const second = selectionToken(
    (await select.execute("second", { path: markerFile, marker: "second" })).details,
  );
  const task = {
    assignment: "Change only owned export",
    context: "Independent exports",
    fixedDecisions: [],
    acceptance: ["Owned export is two"],
  };
  const batch = session.getToolByName("conduct_batch")!;
  await expect(
    batch.execute("expired", { tasks: [{ ...task, selection: old, files: ["target.ts"] }] }),
  ).rejects.toThrow("expired selection");
  const bothStarted = Promise.withResolvers<void>();
  const releaseWorkers = Promise.withResolvers<void>();
  const captureStarted = Promise.withResolvers<void>();
  const releaseCapture = Promise.withResolvers<void>();
  const directives: string[] = [];
  const signals: AbortSignal[] = [];
  const worker = spyOn(workers, "runWorker").mockImplementation(async (input) => {
    directives.push(input.directive);
    signals.push(input.signal);
    if (directives.length === 2) bothStarted.resolve();
    await releaseWorkers.promise;
    await Bun.write(path.join(input.worktree, input.files[0]), "export const value = 2;\n");
    return {
      index: 0,
      id: input.files[0],
      agent: "conduct-worker",
      agentSource: "project",
      task: input.assignment,
      exitCode: 0,
      output: "",
      stderr: "",
      truncated: false,
      durationMs: 0,
      tokens: 0,
      requests: 0,
    } satisfies SingleResult;
  });
  const finish = candidates.finishCandidate;
  const capture = spyOn(candidates, "finishCandidate").mockImplementation(async (...args) => {
    if (args[0].candidate.files.includes("other.ts")) {
      captureStarted.resolve();
      await releaseCapture.promise;
    }
    return finish(...args);
  });
  restores.push(
    () => worker.mockRestore(),
    () => capture.mockRestore(),
  );
  const tasks = [
    { ...task, selection: first, files: ["target.ts"] },
    { ...task, selection: second, files: ["other.ts"] },
  ];
  const execution = batch.execute("batch", { tasks });
  let cancellation: Promise<void> | undefined;
  try {
    await bothStarted.promise;
    expect(directives).toEqual([
      "// OMP-CONDUCT BEGIN: first\n// First\n// OMP-CONDUCT END: first",
      "// OMP-CONDUCT BEGIN: second\n// Second\n// OMP-CONDUCT END: second",
    ]);
    const before = savedState(session);
    for (const action of [
      "workers 3",
      "fast worker on",
      "advisor conduct-cloud/worker",
      "on",
      "off",
    ])
      await command(session, action);
    expect(savedState(session)).toEqual(before);
    await expect(
      session.getToolByName("conduct_task")!.execute("busy", {
        ...task,
        directive: "Another",
        files: ["third.ts"],
      }),
    ).rejects.toThrow("already running");
    releaseWorkers.resolve();
    await captureStarted.promise;
    await expect(
      session.getToolByName("conduct_candidate")!.execute("busy-review", {}),
    ).rejects.toThrow();
    let settled = false;
    void execution.then(() => {
      settled = true;
    });
    cancellation = command(session, "cancel");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    releaseCapture.resolve();
    await cancellation;
    expect(await execution).toMatchObject({
      isError: false,
      details: {
        results: [
          { details: { status: "ready", candidate: { files: ["target.ts"] } } },
          { details: { status: "ready", candidate: { files: ["other.ts"] } } },
        ],
      },
    });
    await expect(batch.execute("consumed", { tasks })).rejects.toThrow("expired selection");
    expect(await Bun.file(path.join(cwd, "target.ts")).text()).toBe("export const value = 1;\n");
    expect(await Bun.file(path.join(cwd, "other.ts")).text()).toBe("export const other = 1;\n");
  } finally {
    releaseWorkers.resolve();
    releaseCapture.resolve();
    await Promise.allSettled([execution, ...(cancellation ? [cancellation] : [])]);
  }
});

test("advisor selection is independent, exact, and persists off across resume", async () => {
  const settings = Settings.isolated({
    "memory.backend": "off",
    "advisor.enabled": true,
    modelRoles: { advisor: "conduct-test/worker" },
    "autolearn.enabled": false,
  });
  const session = await openSession(undefined, settings);
  await command(session, "model conduct-test/worker");
  expect(savedState(session)).not.toHaveProperty("advisorModel", expect.any(String));
  await command(session, "advisor conduct-cloud/worker");
  expect(savedState(session)).toMatchObject({
    model: "conduct-test/worker",
    advisorModel: "conduct-cloud/worker",
  });
  await command(session, "advisor worker");
  await command(session, "advisor conduct-cloud/missing");
  expect(savedState(session)).toMatchObject({ advisorModel: "conduct-cloud/worker" });
  expect(settings.get("advisor.enabled")).toBe(true);
  expect(settings.get("modelRoles")).toEqual({ advisor: "conduct-test/worker" });
  expect(session.model?.provider).toBe("conduct-test");
  await command(session, "on");
  await command(session, "off");
  expect(savedState(session)).toMatchObject({
    enabled: false,
    advisorModel: "conduct-cloud/worker",
  });
  const manager = session.sessionManager;
  await manager.ensureOnDisk();
  await manager.flush();
  const sessionFile = manager.getSessionFile()!;
  await session.dispose();
  sessions.splice(sessions.indexOf(session), 1);
  const resumed = await openSession(await SessionManager.open(sessionFile));
  await command(resumed, "on");
  expect(savedState(resumed)).toMatchObject({ advisorModel: "conduct-cloud/worker" });
  await command(resumed, "advisor off");
  await command(resumed, "off");
  await resumed.sessionManager.flush();
  await resumed.dispose();
  sessions.splice(sessions.indexOf(resumed), 1);
  const offResumed = await openSession(await SessionManager.open(sessionFile));
  await command(offResumed, "on");
  expect(savedState(offResumed)).not.toHaveProperty("advisorModel", expect.any(String));
});

test("one worker at a time; off requires explicit cancellation and blocks subsequent dispatch", async () => {
  const session = await openSession();
  await command(session, "model conduct-test/worker");
  await command(session, "on");
  const started = Promise.withResolvers<void>();
  const spy = spyOn(workers, "runWorker").mockImplementation(async (input) => {
    expect(input.brief.advisorModel).toBeUndefined();
    expect(input.brief.workerFast).toBe(false);
    expect(input.brief.advisorFast).toBe(false);
    await Bun.write(path.join(input.worktree, "target.ts"), "export const value = 2;\n");
    started.resolve();
    const stopped = Promise.withResolvers<void>();
    if (input.signal.aborted) stopped.resolve();
    else input.signal.addEventListener("abort", () => stopped.resolve(), { once: true });
    await stopped.promise;
    return {
      index: 0,
      id: "controlled-worker",
      agent: "conduct-worker",
      agentSource: "project",
      task: "deferred implementation",
      exitCode: 1,
      output: "",
      stderr: "",
      truncated: false,
      durationMs: 0,
      tokens: 0,
      requests: 0,
      aborted: true,
    } satisfies SingleResult;
  });
  restores.push(() => spy.mockRestore());
  const tool = session.getToolByName("conduct_task")!;
  const args = {
    directive: "Complete this function",
    assignment: "Only fill its existing body",
    context: "Existing target implementation and callers",
    fixedDecisions: ["Preserve unrelated behavior"],
    acceptance: ["Requested target behavior is implemented"],
    files: ["target.ts"],
  };
  const first = tool.execute("first", args);
  await started.promise;
  const beforeFast = savedState(session);
  await command(session, "fast worker on");
  await command(session, "fast advisor on");
  expect(savedState(session)).toEqual(beforeFast);
  await command(session, "advisor conduct-cloud/worker");
  expect(savedState(session)).not.toHaveProperty("advisorModel", expect.any(String));
  await expect(tool.execute("second", args)).rejects.toThrow("already running");
  await command(session, "off");
  expect(session.getActiveToolNames()).toContain("conduct_task");
  const transition = await session.extensionRunner!.emit({
    type: "session_before_switch",
    reason: "new",
  });
  expect(transition).toMatchObject({ cancel: true });
  await command(session, "off cancel");
  const cancelled = await first;
  expect(cancelled.isError).toBe(true);
  expect(
    await Bun.file(path.join(session.extensionRunner!.createContext().cwd, "target.ts")).text(),
  ).toBe("export const value = 1;\n");
  expect(session.getActiveToolNames()).toContain("conduct_candidate");
  const retained = await session.getToolByName("conduct_candidate")!.execute("retained", {});
  expect(retained.details).toMatchObject({
    candidates: [{ status: "cancelled", changes: ["target.ts"] }],
  });
  expect(session.getActiveToolNames()).not.toContain("conduct_task");
  await expect(tool.execute("third", args)).rejects.toThrow("Conduct is off");
});

test.each(["cancel", "off cancel"])(
  "%s during capture waits without cancelling a completed candidate",
  async (action) => {
    const session = await openSession();
    await command(session, "model conduct-test/worker");
    await command(session, "on");
    const captureStarted = Promise.withResolvers<void>();
    const releaseCapture = Promise.withResolvers<void>();
    let workerSignal: AbortSignal | undefined;
    const worker = spyOn(workers, "runWorker").mockImplementation(async (input) => {
      workerSignal = input.signal;
      await Bun.write(path.join(input.worktree, "target.ts"), "export const value = 2;\n");
      return {
        index: 0,
        id: "capture-worker",
        agent: "conduct-worker",
        agentSource: "project",
        task: input.assignment,
        exitCode: 0,
        output: "",
        stderr: "",
        truncated: false,
        durationMs: 0,
        tokens: 0,
        requests: 0,
      } satisfies SingleResult;
    });
    const finish = candidates.finishCandidate;
    const capture = spyOn(candidates, "finishCandidate").mockImplementation(async (...args) => {
      captureStarted.resolve();
      await releaseCapture.promise;
      return finish(...args);
    });
    restores.push(
      () => worker.mockRestore(),
      () => capture.mockRestore(),
    );
    const execution = session.getToolByName("conduct_task")!.execute("capture", {
      directive: "Change value to two",
      assignment: "Only target.ts",
      context: "Existing target implementation and callers",
      fixedDecisions: ["Preserve unrelated behavior"],
      acceptance: ["Requested target behavior is implemented"],
      files: ["target.ts"],
    });
    let cancellation: Promise<void> | undefined;
    try {
      await captureStarted.promise;
      const runner = session.extensionRunner!;
      const ctx = runner.createCommandContext();
      const notifications: { type: unknown }[] = [];
      let commandFinished = false;
      cancellation = Promise.resolve(
        runner.getCommand("conduct")!.handler(action, {
          ...ctx,
          ui: {
            ...ctx.ui,
            notify: (_message, type) => {
              notifications.push({ type });
            },
          },
        }),
      ).then(() => {
        commandFinished = true;
      });
      await Promise.resolve();
      expect(workerSignal?.aborted).toBe(false);
      expect(commandFinished).toBe(false);
      expect(notifications).toEqual([]);
      releaseCapture.resolve();
      await cancellation;
      const completed = await execution;
      expect(completed.isError).toBe(false);
      expect(completed.details).toMatchObject({ status: "ready" });
      expect(notifications).toEqual([{ type: "info" }]);
      expect(workerSignal?.aborted).toBe(false);
      const retained = await session.getToolByName("conduct_candidate")!.execute("retained", {});
      expect(retained.details).toMatchObject({
        candidates: [{ status: "ready", changes: ["target.ts"] }],
      });
      expect(await Bun.file(path.join(ctx.cwd, "target.ts")).text()).toBe(
        "export const value = 1;\n",
      );
      expect(session.getActiveToolNames().includes("conduct_task")).toBe(action === "cancel");
    } finally {
      releaseCapture.resolve();
      await Promise.allSettled([execution, ...(cancellation ? [cancellation] : [])]);
    }
  },
);

function selectionToken(details: unknown): string {
  if (
    !details ||
    typeof details !== "object" ||
    !("selection" in details) ||
    typeof details.selection !== "string"
  )
    throw new Error("Selection did not return an opaque token");
  return details.selection;
}

test("incomplete structured handoffs fail before snapshot creation", async () => {
  const session = await openSession();
  await command(session, "model conduct-test/worker");
  await command(session, "on");
  const prepare = spyOn(candidates, "prepareCandidate").mockImplementation(async () => {
    throw new Error("must not create a snapshot");
  });
  restores.push(() => prepare.mockRestore());
  const args = {
    directive: "Change value to two",
    assignment: "Only target.ts",
    files: ["target.ts"],
    context: "Existing implementation",
    fixedDecisions: [],
    acceptance: ["Exported value is two"],
  };
  for (const invalid of [
    { context: undefined },
    { context: " \r\n\t" },
    { fixedDecisions: undefined },
    { fixedDecisions: [" "] },
    { acceptance: undefined },
    { acceptance: [] },
    { acceptance: ["\t"] },
  ]) {
    await expect(
      session.getToolByName("conduct_task")!.execute("invalid", { ...args, ...invalid }),
    ).rejects.toThrow();
  }
  expect(prepare).not.toHaveBeenCalled();
});

test("marker lookup does not dispatch; explicit tokens preserve source and reject stale intent", async () => {
  const session = await openSession();
  await command(session, "model conduct-test/worker");
  await command(session, "on");
  const ctx = session.extensionRunner!.createContext();
  const filename = path.join(ctx.cwd, "deferred code.ts");
  const directive =
    "\t// OMP-CONDUCT BEGIN: merge\r\n\t// Preserve café and both inputs.\r\n\t// OMP-CONDUCT END: merge";
  await Bun.write(filename, `// OMP-CONDUCT: another task\r\n${directive}\r\n`);
  const directives: string[] = [];
  const spy = spyOn(workers, "runWorker").mockImplementation(async (input) => {
    directives.push(input.directive);
    throw new Error("worker-boundary-probe");
  });
  restores.push(() => spy.mockRestore());
  const select = session.getToolByName("conduct_select")!;
  const dispatch = session.getToolByName("conduct_task")!;
  const listing = await select.execute("list", { path: filename, marker: null, line: null });
  expect(listing.details).toMatchObject({
    markers: [{ startLine: 1 }, { name: "merge", startLine: 2, endLine: 4 }],
  });
  const chosen = await select.execute("select", { path: filename, marker: "merge", line: null });
  const selection = selectionToken(chosen.details);
  expect(directives).toEqual([]);
  await expect(
    dispatch.execute("ambiguous", {
      selection,
      directive: "replacement",
      assignment: "Keep scope",
      context: "Existing target implementation and callers",
      fixedDecisions: ["Preserve unrelated behavior"],
      acceptance: ["Requested target behavior is implemented"],
      files: [filename],
    }),
  ).rejects.toThrow("exactly one");
  await expect(
    dispatch.execute("selected", {
      selection,
      directive: null,
      assignment: "Implement the named function only",
      context: "Existing target implementation and callers",
      fixedDecisions: ["Preserve unrelated behavior"],
      acceptance: ["Requested target behavior is implemented"],
      files: [filename],
    }),
  ).resolves.toMatchObject({ isError: true, details: { status: "failed" } });
  expect(directives).toEqual([directive]);
  const fresh = await select.execute("fresh", { path: filename, marker: "merge" });
  await Bun.write(
    filename,
    `// OMP-CONDUCT: another task\r\n${directive}\r\nconst humanEdit = true;\r\n`,
  );
  await expect(
    dispatch.execute("stale", {
      selection: selectionToken(fresh.details),
      assignment: "Implement the named function only",
      context: "Existing target implementation and callers",
      fixedDecisions: ["Preserve unrelated behavior"],
      acceptance: ["Requested target behavior is implemented"],
      files: [filename],
    }),
  ).rejects.toThrow("source changed");
  expect(directives).toEqual([directive]);
});

test("executor tasks preserve significant whitespace in freeform and selected payloads", async () => {
  const session = await openSession();
  await command(session, "model conduct-test/worker");
  await command(session, "on");
  const directive =
    "\t// OMP-CONDUCT BEGIN: banner\r\nconst expected = `alpha  \r\n\r\n\r\nomega\t`;\r\n\t// OMP-CONDUCT END: banner  ";
  const assignment = "Preserve this literal too:\r\n`first  \r\n\r\n\r\nlast\t`  ";
  const handoff = {
    context: "Preserve the supplied literal payloads.",
    fixedDecisions: ["Whitespace is significant."],
    acceptance: ["Both original payloads reach the executor unchanged."],
  };
  const tasks: string[] = [];
  const stop = new Error("executor-boundary-probe");
  const spy = spyOn(codingAgent, "runSubprocess").mockImplementation(async (input) => {
    tasks.push(input.task);
    throw stop;
  });
  restores.push(() => spy.mockRestore());
  const dispatch = session.getToolByName("conduct_task")!;
  await expect(
    dispatch.execute("freeform", {
      ...handoff,
      directive,
      selection: null,
      assignment,
      files: ["target.ts"],
    }),
  ).resolves.toMatchObject({ isError: true, details: { status: "failed" } });

  const filename = path.join(session.extensionRunner!.createContext().cwd, "banner.ts");
  await Bun.write(filename, `${directive}\r\n`);
  const chosen = await session
    .getToolByName("conduct_select")!
    .execute("choose", { path: filename });
  await expect(
    dispatch.execute("selected", {
      ...handoff,
      selection: selectionToken(chosen.details),
      assignment,
      files: [filename],
    }),
  ).resolves.toMatchObject({ isError: true, details: { status: "failed" } });

  expect(tasks).toHaveLength(2);
  for (const task of tasks) {
    expect(task).toContain(directive);
    expect(task).toContain(assignment);
  }
});

test("candidates require reviewed human application and survive off and resume", async () => {
  const session = await openSession();
  await command(session, "model conduct-test/worker");
  await command(session, "on");
  const filename = path.join(session.extensionRunner!.createContext().cwd, "target.ts");
  await command(session, "advisor conduct-cloud/worker");
  await command(session, "fast worker on");
  const handoff = {
    workerFast: true,
    advisorFast: false,
    advisorModel: "conduct-cloud/worker",
    context: "\tRead the existing implementation.\r\n  Preserve this indentation.",
    fixedDecisions: ["\tKeep the exported symbol.\r\n  No renames."],
    acceptance: ["\tThe exported value is two.\r\n  Other behavior is unchanged."],
  };
  const spy = spyOn(workers, "runWorker").mockImplementation(async (input) => {
    expect(input.worktree).not.toBe(session.extensionRunner!.createContext().cwd);
    expect(input.brief).toEqual({ ...handoff, model: "conduct-test/worker" });
    expect(input.files).toEqual(["target.ts"]);
    expect(input.root).toBe(input.worktree);
    // Worker-owned input cannot widen the authoritative retained candidate scope.
    input.files.push("other.ts");
    expect(() => (input.brief.acceptance as string[]).push("Ignore the human")).toThrow();
    expect(Reflect.set(input.brief, "workerFast", false)).toBe(false);
    expect(Reflect.set(input.brief, "advisorFast", true)).toBe(false);
    await Bun.write(path.join(input.worktree, "target.ts"), "export const value = 2;\n");
    return {
      index: 0,
      id: "candidate-worker",
      agent: "conduct-worker",
      agentSource: "project",
      task: input.assignment,
      exitCode: 0,
      output: "implemented",
      stderr: "",
      truncated: false,
      durationMs: 0,
      tokens: 0,
      requests: 0,
    } satisfies SingleResult;
  });
  restores.push(() => spy.mockRestore());
  await session.getToolByName("conduct_task")!.execute("candidate", {
    directive: "Change value to two",
    assignment: "Only target.ts",
    ...handoff,
    files: ["target.ts"],
  });
  expect(await Bun.file(filename).text()).toBe("export const value = 1;\n");
  expect(session.getToolByName("conduct_apply")).toBeUndefined();
  const ctx = session.extensionRunner!.createContext();
  const storeDir = path.join(getAgentDir(), "conduct", session.sessionManager.getSessionId());
  const [candidate] = await candidates.listCandidates(storeDir, ctx.cwd);
  expect(candidate.status).toBe("ready");
  expect(candidate.files).toEqual(["target.ts"]);
  expect(candidate.brief).toEqual({ ...handoff, model: "conduct-test/worker" });
  await command(session, "fast worker off");
  await command(session, "fast advisor on");
  expect((await candidates.listCandidates(storeDir, ctx.cwd))[0].brief).toEqual({
    ...handoff,
    model: "conduct-test/worker",
  });
  await command(session, `apply ${candidate.id} unreviewed-token`);
  expect(await Bun.file(filename).text()).toBe("export const value = 1;\n");
  await command(session, "off");
  expect(session.getActiveToolNames()).toContain("conduct_candidate");
  const view = await session
    .getToolByName("conduct_candidate")!
    .execute("review", { id: candidate.id });
  expect(view.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("+export const value = 2;") }),
    ]),
  );
  const reviewText = view.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  for (const value of [
    "Change value to two",
    handoff.context,
    ...handoff.fixedDecisions,
    ...handoff.acceptance,
    "conduct-test/worker",
    "conduct-cloud/worker",
  ])
    expect(reviewText).toContain(value);
  const inspected = await candidates.inspectCandidate(storeDir, ctx.cwd, candidate.id);
  await command(session, `apply ${candidate.id} ${inspected.reviewToken}`);
  expect(await Bun.file(filename).text()).toBe("export const value = 1;\n");
  const manager = session.sessionManager;
  await manager.ensureOnDisk();
  await manager.flush();
  const sessionFile = manager.getSessionFile()!;
  await session.dispose();
  sessions.splice(sessions.indexOf(session), 1);
  const resumed = await openSession(await SessionManager.open(sessionFile));
  expect(resumed.getActiveToolNames()).toContain("conduct_candidate");
  const review = await resumed
    .getToolByName("conduct_candidate")!
    .execute("restored-review", { id: candidate.id });
  expect((await candidates.listCandidates(storeDir, ctx.cwd))[0].brief).toEqual({
    ...handoff,
    model: "conduct-test/worker",
  });
  const details = review.details as { reviewToken: string };
  expect(details.reviewToken).toBeString();
  await command(resumed, "on");
  const recordPath = path.join(path.dirname(candidate.patchPath), "record.json");
  const originalRecord = await fs.readFile(recordPath, "utf8");
  for (const key of ["workerFast", "advisorFast"] as const) {
    const altered = JSON.parse(originalRecord);
    altered.brief[key] = !altered.brief[key];
    await fs.writeFile(recordPath, JSON.stringify(altered));
    await expect(
      candidates.applyCandidate(storeDir, ctx.cwd, candidate.id, details.reviewToken),
    ).rejects.toThrow("Review token");
    altered.brief[key] = "on";
    await fs.writeFile(recordPath, JSON.stringify(altered));
    await expect(candidates.inspectCandidate(storeDir, ctx.cwd, candidate.id)).rejects.toThrow(
      "Invalid candidate fast preference",
    );
  }
  await fs.writeFile(recordPath, originalRecord);
  await command(resumed, `apply ${candidate.id} ${details.reviewToken}`);
  expect(await Bun.file(filename).text()).toBe("export const value = 2;\n");
});

test("snapshot selection mismatch retains a failed candidate without dispatch", async () => {
  const session = await openSession();
  await command(session, "model conduct-test/worker");
  await command(session, "on");
  const ctx = session.extensionRunner!.createContext();
  const filename = path.join(ctx.cwd, "marker.ts");
  await Bun.write(filename, "// OMP-CONDUCT: finish target\n");
  const selected = await session
    .getToolByName("conduct_select")!
    .execute("select", { path: filename });
  const prepare = candidates.prepareCandidate;
  const spy = spyOn(candidates, "prepareCandidate").mockImplementation(async (input) => {
    const prepared = await prepare(input);
    await Bun.write(
      path.join(prepared.worktree, "marker.ts"),
      "// OMP-CONDUCT: different request\n",
    );
    return prepared;
  });
  const worker = spyOn(workers, "runWorker").mockImplementation(async () => {
    throw new Error("must not dispatch");
  });
  restores.push(
    () => spy.mockRestore(),
    () => worker.mockRestore(),
  );
  await expect(
    session.getToolByName("conduct_task")!.execute("mismatch", {
      selection: selectionToken(selected.details),
      assignment: "Implement target only",
      context: "Existing target implementation and callers",
      fixedDecisions: ["Preserve unrelated behavior"],
      acceptance: ["Requested target behavior is implemented"],
      files: ["target.ts"],
    }),
  ).rejects.toThrow("snapshot mismatch");
  expect(worker).not.toHaveBeenCalled();
  expect(await Bun.file(filename).text()).toBe("// OMP-CONDUCT: finish target\n");
  const records = await candidates.listCandidates(
    path.join(getAgentDir(), "conduct", session.sessionManager.getSessionId()),
    ctx.cwd,
  );
  expect(records).toMatchObject([{ status: "failed" }]);
});

test("selection tokens cannot cross sessions or survive mode off and resume", async () => {
  const session = await openSession();
  await command(session, "model conduct-test/worker");
  await command(session, "on");
  const filename = path.join(session.extensionRunner!.createContext().cwd, "source.py");
  await Bun.write(filename, "# OMP-CONDUCT: finish this function\n");
  const chosen = await session
    .getToolByName("conduct_select")!
    .execute("choose", { path: filename });
  const selection = selectionToken(chosen.details);
  const args = {
    selection,
    assignment: "Finish the existing function",
    context: "Existing target implementation and callers",
    fixedDecisions: ["Preserve unrelated behavior"],
    acceptance: ["Requested target behavior is implemented"],
    files: [filename],
  };
  const other = await openSession();
  await command(other, "model conduct-test/worker");
  await command(other, "on");
  await expect(other.getToolByName("conduct_task")!.execute("foreign", args)).rejects.toThrow(
    "expired selection",
  );
  await command(session, "off");
  expect(session.getActiveToolNames()).not.toContain("conduct_select");
  await command(session, "on");
  await expect(session.getToolByName("conduct_task")!.execute("cleared", args)).rejects.toThrow(
    "expired selection",
  );

  const newSelection = await session
    .getToolByName("conduct_select")!
    .execute("choose-again", { path: filename });
  const manager = session.sessionManager;
  await manager.ensureOnDisk();
  await manager.flush();
  const sessionFile = manager.getSessionFile()!;
  await session.dispose();
  sessions.splice(sessions.indexOf(session), 1);
  const resumed = await openSession(await SessionManager.open(sessionFile));
  await expect(
    resumed.getToolByName("conduct_task")!.execute("resumed", {
      ...args,
      selection: selectionToken(newSelection.details),
    }),
  ).rejects.toThrow("expired selection");
});
