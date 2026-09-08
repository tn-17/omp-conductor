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

async function openSession(manager?: SessionManager): Promise<AgentSession> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-test-"));
  directories.push(directory);
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
    cwd: directory,
    agentDir: directory,
    modelRegistry: registry,
    model: registry.find("conduct-test", "worker"),
    sessionManager: manager ?? SessionManager.create(directory, path.join(directory, "sessions")),
    settings: Settings.isolated({
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

test("one worker at a time; off requires explicit cancellation and blocks subsequent dispatch", async () => {
  const session = await openSession();
  await command(session, "model conduct-test/worker");
  await command(session, "on");
  const started = Promise.withResolvers<void>();
  const spy = spyOn(workers, "runWorker").mockImplementation(async (input) => {
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
  const args = { directive: "Complete this function", assignment: "Only fill its existing body" };
  const first = tool.execute("first", args);
  await started.promise;
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
  expect(session.getActiveToolNames()).not.toContain("conduct_task");
  await expect(tool.execute("third", args)).rejects.toThrow("Conduct is off");
});

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
  const listing = await select.execute("list", { path: filename });
  expect(listing.details).toMatchObject({
    markers: [{ startLine: 1 }, { name: "merge", startLine: 2, endLine: 4 }],
  });
  const chosen = await select.execute("select", { path: filename, marker: "merge" });
  const selection = selectionToken(chosen.details);
  expect(directives).toEqual([]);
  await expect(
    dispatch.execute("ambiguous", {
      selection,
      directive: "replacement",
      assignment: "Keep scope",
    }),
  ).rejects.toThrow("exactly one");
  await expect(
    dispatch.execute("selected", { selection, assignment: "Implement the named function only" }),
  ).rejects.toThrow("worker-boundary-probe");
  expect(directives).toEqual([directive]);
  await Bun.write(
    filename,
    `// OMP-CONDUCT: another task\r\n${directive}\r\nconst humanEdit = true;\r\n`,
  );
  await expect(
    dispatch.execute("stale", { selection, assignment: "Implement the named function only" }),
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
  const tasks: string[] = [];
  const stop = new Error("executor-boundary-probe");
  const spy = spyOn(codingAgent, "runSubprocess").mockImplementation(async (input) => {
    tasks.push(input.task);
    throw stop;
  });
  restores.push(() => spy.mockRestore());
  const dispatch = session.getToolByName("conduct_task")!;
  await expect(dispatch.execute("freeform", { directive, assignment })).rejects.toThrow(stop);

  const filename = path.join(session.extensionRunner!.createContext().cwd, "banner.ts");
  await Bun.write(filename, `${directive}\r\n`);
  const chosen = await session
    .getToolByName("conduct_select")!
    .execute("choose", { path: filename });
  await expect(
    dispatch.execute("selected", {
      selection: selectionToken(chosen.details),
      assignment,
    }),
  ).rejects.toThrow(stop);

  expect(tasks).toHaveLength(2);
  for (const task of tasks) {
    expect(task).toContain(directive);
    expect(task).toContain(assignment);
  }
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
  const args = { selection, assignment: "Finish the existing function" };
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
      selection: selectionToken(newSelection.details),
      assignment: args.assignment,
    }),
  ).rejects.toThrow("expired selection");
});
