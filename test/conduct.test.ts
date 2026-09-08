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
