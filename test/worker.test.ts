import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as sdk from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { runWorker } from "../worker";

async function openTestSession(directory: string) {
  const auth = await sdk.discoverAuthStorage(directory);
  const registry = new sdk.ModelRegistry(auth, path.join(directory, "models.json"));
  registry.registerProvider("cleanup-test", {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "test-key",
    models: [
      {
        id: "worker",
        name: "Worker",
        contextWindow: 16000,
        maxTokens: 1024,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const { session } = await sdk.createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRegistry: registry,
    model: registry.find("cleanup-test", "worker")!,
    settings: sdk.Settings.isolated({
      "memory.backend": "off",
      "advisor.enabled": false,
      "autolearn.enabled": false,
    }),
    sessionManager: sdk.SessionManager.inMemory(directory),
    extensions: [() => {}],
    disableExtensionDiscovery: true,
    skills: [],
    contextFiles: [],
    rules: [],
    promptTemplates: [],
    slashCommands: [],
    enableMCP: false,
    enableLsp: false,
    skipPythonPreflight: true,
    toolNames: [],
  });
  return { session, registry };
}

test("worker policy blocks newly registered capabilities while guarded writes remain usable", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-worker-policy-"));
  const { session, registry } = await openTestSession(directory);
  const escaped = path.join(directory, "escape.txt");
  let child: sdk.AgentSession | undefined;
  const intercept = spyOn(sdk, "runSubprocess").mockImplementation(async (input) => {
    const created = await sdk.createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRegistry: registry,
      model: registry.find("cleanup-test", "worker")!,
      settings: input.settings,
      sessionManager: sdk.SessionManager.inMemory(directory),
      toolNames: input.agent.tools,
      requireYieldTool: true,
      customTools: input.customTools,
      preloadedPreparedExtensions: input.preloadedPreparedExtensions,
      preloadedCustomToolPaths: [],
      extensions: [
        (pi) => {
          pi.registerTool({
            name: "escape",
            label: "Unapproved capability",
            description: "A newly registered capability outside the worker policy",
            parameters: pi.typebox.Type.Object({}),
            async execute() {
              await fs.writeFile(escaped, "escaped");
              return { content: [{ type: "text", text: "escaped" }] };
            },
          });
        },
      ],
      disableExtensionDiscovery: true,
      contextFiles: [],
      skills: [],
      rules: [],
      promptTemplates: [],
      slashCommands: [],
      enableMCP: false,
      enableLsp: false,
      skipPythonPreflight: true,
    });
    child = created.session;
    await initializeExtensions(child, {
      mode: "print",
      reportSendError: (error) => {
        throw error;
      },
      reportRuntimeError: (error) => {
        throw error;
      },
    });
    const escape = child.getToolByName("escape");
    expect(escape).toBeDefined();
    let denied = false;
    try {
      const result = await escape!.execute("unapproved", {});
      denied = result.isError === true;
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
    expect(await fs.lstat(escaped).catch(() => null)).toBeNull();
    const result = await child.getToolByName("conduct_write")!.execute("allowed", {
      path: "candidate.txt",
      content: "guarded write",
    });
    expect(result.isError).not.toBe(true);
    expect(await fs.readFile(path.join(directory, "candidate.txt"), "utf8")).toBe("guarded write");
    return {
      id: input.id,
      index: 0,
      agent: "conduct-worker",
      agentSource: "project",
      task: input.task,
      exitCode: 0,
      output: "",
      stderr: "",
      truncated: false,
      durationMs: 0,
      tokens: 0,
      requests: 0,
    } satisfies sdk.SingleResult;
  });
  try {
    await initializeExtensions(session, {
      mode: "print",
      reportSendError: (error) => {
        throw error;
      },
      reportRuntimeError: (error) => {
        throw error;
      },
    });
    await runWorker({
      ctx: session.extensionRunner!.createContext(),
      model: registry.find("cleanup-test", "worker")!,
      directive: "Write the candidate only.",
      assignment: "Only candidate.txt.",
      brief: {
        context: "Saved file",
        fixedDecisions: [],
        acceptance: ["Write candidate"],
        model: "cleanup-test/worker",
      },
      root: directory,
      files: ["candidate.txt"],
      worktree: directory,
      signal: new AbortController().signal,
      onProgress: () => {},
    });
  } finally {
    intercept.mockRestore();
    await child?.dispose();
    await session.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cancelled workers settle owned writes before candidate capture can begin", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-worker-cleanup-"));
  const { session, registry } = await openTestSession(directory);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const output = path.join(directory, "candidate.txt");
  const spy = spyOn(sdk, "runSubprocess").mockImplementation(async (input) => {
    input.onCleanupDeferred?.(
      release.promise.then(async () => {
        await Bun.write(output, "last worker-owned write");
      }),
    );
    entered.resolve();
    return {
      id: input.id,
      index: 0,
      agent: "conduct-worker",
      agentSource: "project",
      task: input.task,
      exitCode: 1,
      aborted: true,
      output: "Cancelled",
      stderr: "",
      truncated: false,
      durationMs: 0,
      tokens: 0,
      requests: 0,
    } satisfies sdk.SingleResult;
  });
  let settled = false;
  let execution: Promise<sdk.SingleResult> | undefined;
  try {
    await initializeExtensions(session, {
      mode: "print",
      reportSendError: (error) => {
        throw error;
      },
      reportRuntimeError: (error) => {
        throw error;
      },
    });
    execution = runWorker({
      ctx: session.extensionRunner!.createContext(),
      model: registry.find("cleanup-test", "worker")!,
      directive: "Finish this implementation.",
      assignment: "Only candidate.txt.",
      brief: {
        context: "Saved candidate file",
        fixedDecisions: [],
        acceptance: ["Finish the implementation"],
        model: "cleanup-test/worker",
      },
      root: directory,
      files: ["candidate.txt"],
      worktree: directory,
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await entered.promise;
    // Drain resolved-result microtasks while cleanup stays blocked on explicit release.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release.resolve();
    await execution;
    expect(await Bun.file(output).text()).toBe("last worker-owned write");
  } finally {
    release.resolve();
    await execution?.catch(() => {});
    spy.mockRestore();
    await session.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
