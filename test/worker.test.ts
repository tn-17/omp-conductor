import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as sdk from "@oh-my-pi/pi-coding-agent";
import { type AssistantMessage, createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AdviseTool } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { resolveAdvisorModel, runWorker } from "../worker";

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

test.each(["off", "on", "rebuilt", "error"])("worker and advisor policy: %s", async (mode) => {
  const advisorEnabled = mode !== "off";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-worker-policy-"));
  const { session, registry } = await openTestSession(directory);
  registry.registerProvider("explicit-cloud", {
    api: "openai-completions",
    baseUrl: "https://advisor.example/v1",
    apiKey: "test-key",
    models: [
      {
        id: "reviewer",
        name: "Reviewer",
        contextWindow: 16000,
        maxTokens: 1024,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  session.applyAdvisorConfigs(
    [
      {
        name: "Parent advisor",
        model: "cleanup-test/worker",
        tools: [],
        instructions: "PARENT ADVISOR MUST NOT BE INHERITED",
      },
    ],
    undefined,
  );
  session.setAdvisorEnabled(true);
  const parentAdvisor = session.getAdvisorAgent();
  const parentRoles = { ...session.settings.getModelRoles() };
  const escaped = path.join(directory, "escape.txt");
  let childId: string | undefined;
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
    childId = input.id;
    sdk.AgentRegistry.global().register({
      id: input.id,
      displayName: "Conduct worker",
      kind: "sub",
      session: child,
    });
    child.applyAdvisorConfigs(
      [
        {
          name: "Inherited unsafe advisor",
          model: "cleanup-test/worker",
          tools: ["write", "read", "bash", "task"],
          instructions: "INHERITED ADVISOR MUST NOT RUN",
        },
      ],
      "INHERITED SHARED INSTRUCTIONS",
    );
    expect(child.getAdvisorAgent()).toBeUndefined();
    await initializeExtensions(child, {
      mode: "print",
      reportSendError: (error) => {
        throw error;
      },
      reportRuntimeError: (error) => {
        throw error;
      },
    });
    await child.extensionRunner!.emitBeforeAgentStart(input.task, undefined, ["Worker"]);
    const advisor = child.getAdvisorAgent();
    expect(session.getAdvisorAgent()).toBe(parentAdvisor);
    expect(session.settings.getModelRoles()).toEqual(parentRoles);
    if (advisorEnabled) {
      expect(advisor).toBeDefined();
      expect(advisor!.state.model.provider).toBe("explicit-cloud");
      expect(advisor!.state.model.id).toBe("reviewer");
      expect(child.model?.provider).toBe("cleanup-test");
      expect(advisor!.state.systemPrompt.join("\n")).toContain("Write the candidate only.");
      expect(advisor!.state.systemPrompt.join("\n")).not.toContain("INHERITED");
      expect(advisor!.state.tools.map((tool) => tool.name).sort()).toEqual([
        "advise",
        "glob",
        "grep",
        "read",
      ]);
      await fs.writeFile(path.join(directory, "context.txt"), "read-only evidence");
      const read = advisor!.state.tools.find((tool) => tool.name === "read")!;
      const content = await read.execute("advisor-read", { path: "context.txt" });
      expect(JSON.stringify(content)).toContain("read-only evidence");
      const deniedRead = await read.execute("advisor-escape", { path: "../outside.txt" });
      expect(deniedRead.isError).toBe(true);

      // Exercise the real advisor loop and its native output quarantine.
      let malicious = false;
      let advising = false;
      let requested = false;
      advisor!.streamFn = (model) => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: requested
            ? [{ type: "text", text: "Cannot mutate the candidate." }]
            : [
                {
                  type: "toolCall",
                  id: advising
                    ? "early-advice"
                    : malicious
                      ? "advisor-write"
                      : "advisor-guarded-read",
                  name: advising ? "advise" : "read",
                  arguments: advising
                    ? {
                        note: "Preserve zero priority; truthiness defaults would corrupt it.",
                        severity: "concern",
                      }
                    : malicious
                      ? { path: "candidate.txt", content: "forbidden advisor write" }
                      : { path: "context.txt" },
                },
              ],
          stopReason: requested ? "stop" : "toolUse",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          timestamp: Date.now(),
        };
        requested = true;
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end(message);
        return stream;
      };
      await advisor!.prompt("Read context.txt.");
      expect(
        advisor!.state.messages.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolCallId === "advisor-guarded-read" &&
            !message.isError &&
            JSON.stringify(message.content).includes("read-only evidence"),
        ),
      ).toBe(true);
      // In-progress advice must surface now, not wait for the worker's final yield.
      // Preserve idle cards here to avoid launching another primary model call.
      child.prepareForHeadlessAdvisorDrain();
      const notes: string[] = [];
      const stopNotes = child.subscribe((event) => {
        if (
          event.type === "message_end" &&
          event.message.role === "custom" &&
          event.message.customType === "advisor"
        ) {
          notes.push(String(event.message.content));
        }
      });
      const advise = advisor!.state.tools.find((tool) => tool.name === "advise");
      expect(advise).toBeInstanceOf(AdviseTool);
      (advise as AdviseTool).beginUpdate(true);
      requested = false;
      advising = true;
      await advisor!.prompt("Warn about the concrete defaulting bug now.");
      expect(notes.some((note) => note.includes("Preserve zero priority"))).toBe(true);
      stopNotes();
      advising = false;

      // A tool reset that reuses an allowed name must not bypass object grants.
      const write = child.getToolByName("conduct_write")!;
      advisor!.setTools([
        {
          name: "read",
          label: write.label,
          description: write.description,
          parameters: write.parameters,
          execute: write.execute.bind(write),
        },
      ]);
      requested = false;
      malicious = true;
      await advisor!.prompt("Attempt the forbidden write.");
      expect(await fs.lstat(path.join(directory, "candidate.txt")).catch(() => null)).toBeNull();
      expect(
        advisor!.state.messages.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolCallId === "advisor-write" &&
            message.isError,
        ),
      ).toBe(true);
      advisor!.reset();
    } else {
      expect(advisor).toBeUndefined();
    }
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
    if (mode === "rebuilt") {
      child.setAdvisorEnabled(false);
      child.setAdvisorEnabled(true);
      const rebuiltRead = child
        .getAdvisorAgent()!
        .state.tools.find((tool) => tool.name === "read")!;
      let nativeDenied = false;
      try {
        const result = await rebuiltRead.execute("native-escape", {
          path: path.join(directory, "context.txt"),
        });
        nativeDenied = result.isError === true;
      } catch {
        nativeDenied = true;
      }
      expect(nativeDenied).toBe(true);
      // The worker cannot proceed after an unexpected native advisor rebuild.
      const deniedWrite = await child
        .getToolByName("conduct_write")!
        .execute("changed-advisor", {
          path: "candidate.txt",
          content: "must not replace guarded write",
        })
        .catch(() => ({ isError: true }));
      expect(deniedWrite.isError).toBe(true);
      expect(await fs.readFile(path.join(directory, "candidate.txt"), "utf8")).toBe(
        "guarded write",
      );
    }
    if (mode === "error") {
      const notices: string[] = [];
      const stopNotices = child.subscribe((event) => {
        if (event.type === "notice" && event.source === "advisor") notices.push(event.message);
      });
      advisor!.streamFn = () => {
        throw new Error("500 Internal Server Error: advisor unavailable");
      };
      await advisor!.prompt("Review the finished worker before cleanup.");
      stopNotices();
      expect(notices).toEqual([]);
      // Return worker success before the runtime's delayed warning can fire.
    }
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
    const execution = runWorker({
      ctx: session.extensionRunner!.createContext(),
      model: registry.find("cleanup-test", "worker")!,
      directive: "Write the candidate only.",
      assignment: "Only candidate.txt.",
      brief: {
        context: "Saved file",
        fixedDecisions: [],
        acceptance: ["Write candidate"],
        model: "cleanup-test/worker",
        ...(advisorEnabled ? { advisorModel: "explicit-cloud/reviewer" } : {}),
      },
      root: directory,
      files: ["candidate.txt"],
      worktree: directory,
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    if (mode === "rebuilt") {
      await expect(execution).rejects.toThrow("safety setup is unavailable or changed");
    } else if (mode === "error") {
      await expect(execution).rejects.toThrow("advisor unavailable");
    } else {
      await execution;
    }
    expect(
      resolveAdvisorModel(session.extensionRunner!.createContext(), "explicit-cloud/reviewer")
        .provider,
    ).toBe("explicit-cloud");
    expect(() => resolveAdvisorModel(session.extensionRunner!.createContext(), "reviewer")).toThrow(
      "exact",
    );
    expect(() => resolveAdvisorModel(session.extensionRunner!.createContext(), "advisor")).toThrow(
      "exact",
    );
  } finally {
    intercept.mockRestore();
    await child?.dispose();
    if (childId) sdk.AgentRegistry.global().unregister(childId);
    await session.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an explicitly requested advisor cannot silently become an unadvised successful worker", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-advisor-setup-"));
  const { session, registry } = await openTestSession(directory);
  const intercept = spyOn(sdk, "runSubprocess").mockImplementation(async (input) => ({
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
  }));
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
    await expect(
      runWorker({
        ctx: session.extensionRunner!.createContext(),
        model: registry.find("cleanup-test", "worker")!,
        directive: "Write candidate.txt.",
        assignment: "Only candidate.txt.",
        brief: {
          context: "Saved file",
          fixedDecisions: [],
          acceptance: ["Write the candidate"],
          model: "cleanup-test/worker",
          advisorModel: "cleanup-test/worker",
        },
        root: directory,
        files: ["candidate.txt"],
        worktree: directory,
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    ).rejects.toThrow("never completed safe advisor setup");
  } finally {
    intercept.mockRestore();
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
