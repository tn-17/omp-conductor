import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as sdk from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { parseReviewReport, resolveReviewerModel, ReviewerError, runReviewer } from "../reviewer";
import { runWorker } from "../worker";
import type { ReviewFinding } from "../review-types";

const finding = {
  id: "F1",
  file: "candidate.txt",
  line: 1,
  severity: "high",
  title: "Incorrect default",
  evidence: "Zero is replaced by one.",
  expected: "Preserve an explicit zero.",
} satisfies ReviewFinding;

test("review findings reject ambiguous, unscoped and malformed evidence", () => {
  expect(parseReviewReport({ summary: "Clean", findings: [] }, ["candidate.txt"]).findings).toEqual(
    [],
  );
  expect(
    parseReviewReport({ summary: "Bug", findings: [finding] }, ["candidate.txt"]).findings[0],
  ).toEqual(finding);
  for (const findings of [
    [finding, finding],
    [{ ...finding, id: " " }],
    [{ ...finding, id: " F1" }],
    [{ ...finding, file: "context.txt" }],
    [{ ...finding, file: "./candidate.txt" }],
    [{ ...finding, line: 0 }],
    [{ ...finding, line: 1.5 }],
    [{ ...finding, severity: "critical" }],
    [{ ...finding, evidence: " " }],
    [{ ...finding, expected: "x".repeat(8001) }],
    [{ ...finding, command: "run code" }],
  ])
    expect(() => parseReviewReport({ summary: "Bug", findings }, ["candidate.txt"])).toThrow();
  expect(() => parseReviewReport({ summary: "Clean", findings: [], approved: true }, [])).toThrow();
});

async function setup(directory: string) {
  const auth = await sdk.discoverAuthStorage(directory);
  const registry = new sdk.ModelRegistry(auth, path.join(directory, "models.json"));
  registry.registerProvider("review-test", {
    api: "openai-completions",
    baseUrl: "https://review.example/v1",
    apiKey: "test-key",
    models: ["parent", "reviewer"].map((id) => ({
      id,
      name: id,
      contextWindow: 16000,
      maxTokens: 1024,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
  const created = await sdk.createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRegistry: registry,
    model: registry.find("review-test", "parent")!,
    settings: sdk.Settings.isolated({
      "tier.subagent": "priority",
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
  await initializeExtensions(created.session, {
    mode: "print",
    reportSendError: (error) => {
      throw error;
    },
    reportRuntimeError: (error) => {
      throw error;
    },
  });
  return { session: created.session, registry };
}

test.each([
  { name: "normal completion below the ceiling", budget: 2, yieldAt: 2, rejected: false },
  { name: "completion at the hard review ceiling", budget: 2, yieldAt: 3, rejected: true },
  { name: "native budget-forced partial yield", budget: 2, yieldAt: 4, rejected: true },
  { name: "explicitly disabled native budget", budget: 0, yieldAt: 4, rejected: false },
])(
  "review request budget: $name",
  async ({ budget, yieldAt, rejected }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-review-budget-"));
    let requests = 0;
    const report = { summary: "Review complete; no issues found.", findings: [] };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        const name = requests >= yieldAt ? "yield" : "conduct_read";
        const args = name === "yield" ? { data: report } : { path: "candidate.txt" };
        const frame = (delta: object, finish_reason: string | null) =>
          `data: ${JSON.stringify({
            id: `budget-${requests}`,
            object: "chat.completion.chunk",
            created: 0,
            model: "reviewer",
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`;
        return new Response(
          frame(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call-${requests}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
            null,
          ) +
            frame({}, "tool_calls") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    let session: sdk.AgentSession | undefined;
    let restore: (() => void) | undefined;
    try {
      const fixture = await setup(directory);
      session = fixture.session;
      fixture.registry.registerProvider("budget-review", {
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "test-key",
        models: [
          {
            id: "reviewer",
            name: "reviewer",
            contextWindow: 16000,
            maxTokens: 1024,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });
      await fs.writeFile(path.join(directory, "candidate.txt"), "candidate");
      const nativeRun = sdk.runSubprocess;
      const intercept = spyOn(sdk, "runSubprocess").mockImplementation(async (options) => {
        // Lower only the isolated test budget; execute the actual SDK monitor,
        // forced wrap-up and strict yield path, not a fabricated result.
        if (!options.settings) throw new Error("Missing isolated reviewer settings.");
        options.settings.set("task.softRequestBudget", budget);
        return nativeRun(options);
      });
      restore = () => intercept.mockRestore();
      const invocation = runReviewer({
        ctx: session.extensionRunner!.createContext(),
        model: fixture.registry.find("budget-review", "reviewer")!,
        directive: "Review the candidate completely.",
        assignment: "Inspect all behavior.",
        brief: {
          context: "Candidate",
          fixedDecisions: [],
          acceptance: ["Complete review"],
          model: "budget-review/reviewer",
        },
        root: directory,
        worktree: directory,
        files: ["candidate.txt"],
        patch: "candidate delta",
        pass: 1,
        previous: [],
        signal: AbortSignal.timeout(10000),
        onProgress: () => {},
      });
      if (rejected) {
        const error: unknown = await invocation.then(
          () => undefined,
          (error) => error,
        );
        expect(error).toBeInstanceOf(ReviewerError);
        if (!(error instanceof ReviewerError))
          throw new Error("Budget-limited review was accepted.");
        expect(error.result?.structuredOutput?.data).toEqual(report);
        expect(error.result?.requests).toBeGreaterThanOrEqual(Math.ceil(budget * 1.5));
        expect(error.result?.exitCode).toBe(0);
        expect(error.result?.aborted).toBe(false);
      } else {
        expect((await invocation).report).toEqual(report);
      }
      expect(requests).toBeGreaterThanOrEqual(yieldAt);
    } finally {
      restore?.();
      await session?.dispose();
      server.stop(true);
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);

test.each([false, true])(
  "native reviewer denies added capabilities and leaves parent isolated (fast=%s)",
  async (fast) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-review-policy-"));
    const { session, registry } = await setup(directory);
    const roles = { ...session.settings.getModelRoles() };
    await fs.writeFile(path.join(directory, "candidate.txt"), "candidate");
    await fs.writeFile(path.join(directory, "context.txt"), "read-only context");
    let child: sdk.AgentSession | undefined;
    let cleanupFinished = false;
    const intercept = spyOn(sdk, "runSubprocess").mockImplementation(async (input) => {
      const created = await sdk.createAgentSession({
        cwd: directory,
        agentDir: directory,
        modelRegistry: registry,
        model: registry.find("review-test", "reviewer")!,
        settings: input.settings,
        sessionManager: sdk.SessionManager.inMemory(directory),
        toolNames: input.agent.tools,
        requireYieldTool: true,
        outputSchema: input.outputSchema,
        outputSchemaMode: input.outputSchemaMode,
        customTools: input.customTools,
        preloadedPreparedExtensions: input.preloadedPreparedExtensions,
        preloadedCustomToolPaths: [],
        extensions: [
          (pi) => {
            pi.registerTool({
              name: "escape",
              label: "Forbidden write",
              description: "Dynamically added capability",
              parameters: pi.typebox.Type.Object({}),
              async execute() {
                await fs.writeFile(path.join(directory, "candidate.txt"), "escaped");
                return { content: [{ type: "text", text: "escaped" }] };
              },
            });
          },
        ],
        disableExtensionDiscovery: true,
        skills: [],
        contextFiles: [],
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
      await child.extensionRunner!.emitBeforeAgentStart(input.task, undefined, ["Reviewer"]);
      const read = child.getToolByName("conduct_read")!;
      expect(JSON.stringify(await read.execute("context", { path: "context.txt" }))).toContain(
        "read-only context",
      );
      expect((await read.execute("outside", { path: "../outside.txt" })).isError).toBe(true);
      const denied = await child
        .getToolByName("escape")!
        .execute("escape", {})
        .catch(() => ({ isError: true }));
      expect(denied.isError).toBe(true);
      expect(await fs.readFile(path.join(directory, "candidate.txt"), "utf8")).toBe("candidate");
      expect(child.getToolByName("conduct_write")).toBeUndefined();
      expect(child.getAdvisorAgent()).toBeUndefined();
      expect(child.model?.id).toBe("reviewer");
      expect(child.settings.get("tier.subagent")).toBe(fast ? "priority" : "none");
      expect(session.settings.get("tier.subagent")).toBe("priority");
      expect(session.settings.getModelRoles()).toEqual(roles);
      const packet = JSON.parse(input.task) as { patch: string; previous: unknown[] };
      expect(packet.patch).toBe("--- original\n+++ candidate\n+changed");
      input.onCleanupDeferred?.(
        Promise.resolve().then(() => {
          cleanupFinished = true;
        }),
      );
      return {
        id: input.id,
        index: 0,
        agent: input.agent.name,
        agentSource: "project",
        task: input.task,
        exitCode: 0,
        output: "",
        stderr: "",
        truncated: false,
        durationMs: 0,
        tokens: 0,
        requests: 0,
        structuredOutput: {
          source: "caller",
          mode: "strict",
          status: "valid",
          data: { summary: "Clean", findings: [] },
        },
      };
    });
    try {
      const ctx = session.extensionRunner!.createContext();
      expect(resolveReviewerModel(ctx, "review-test/reviewer").id).toBe("reviewer");
      expect(() => resolveReviewerModel(ctx, "reviewer")).toThrow();
      const reviewed = await runReviewer({
        ctx,
        model: registry.find("review-test", "reviewer")!,
        directive: "Preserve zero.",
        assignment: "Fix the default.",
        brief: {
          context: "Defaulting",
          fixedDecisions: [],
          acceptance: ["Zero preserved"],
          model: "review-test/parent",
          reviewerFast: fast,
        },
        root: directory,
        worktree: directory,
        files: ["candidate.txt"],
        patch: "--- original\n+++ candidate\n+changed",
        pass: 1,
        previous: [],
        signal: new AbortController().signal,
        onProgress: () => {},
      });
      expect(reviewed.report.findings).toEqual([]);
      expect(cleanupFinished).toBe(true);
    } finally {
      intercept.mockRestore();
      await child?.dispose();
      await session.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

test.each(["reviewer", "worker"])(
  "%s refuses auto-discovered executable commands before session creation",
  async (role) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-command-discovery-"));
    const { session, registry } = await setup(directory);
    registry.registerProvider("review-local", {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test-key",
      models: [
        {
          id: "worker",
          name: "worker",
          contextWindow: 16000,
          maxTokens: 1024,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const sentinel = path.join(directory, "executed");
    const commandDir = path.join(directory, ".omp", "commands", "escape");
    await fs.mkdir(commandDir, { recursive: true });
    await fs.writeFile(
      path.join(commandDir, "index.ts"),
      `await Bun.write(${JSON.stringify(sentinel)}, "executed"); export default () => ({name:"escape",description:"probe",execute:async()=>{}});`,
    );
    await fs.writeFile(path.join(directory, "candidate.txt"), "candidate");
    let child: sdk.AgentSession | undefined;
    const intercept = spyOn(sdk, "runSubprocess").mockImplementation(async (input) => {
      const model =
        role === "reviewer"
          ? registry.find("review-test", "reviewer")!
          : registry.find("review-local", "worker")!;
      const created = await sdk.createAgentSession({
        cwd: directory,
        modelRegistry: registry,
        model,
        settings: input.settings,
        sessionManager: sdk.SessionManager.inMemory(directory),
        toolNames: input.agent.tools,
        customTools: input.customTools,
        restrictToolNames: input.restrictToolNames,
        extensionRoots: input.extensionRoots,
        preloadedExtensionPaths: input.preloadedExtensionPaths,
        preloadedPreparedExtensions: input.preloadedPreparedExtensions,
        preloadedCustomToolPaths: input.preloadedCustomToolPaths,
        contextFiles: [],
        skills: [],
        rules: [],
        promptTemplates: [],
        slashCommands: [],
        enableMCP: false,
        enableLsp: false,
        skipPythonPreflight: true,
        // Intentionally do not add disableExtensionDiscovery: ExecutorOptions
        // cannot forward it; this is the real native startup discovery path.
      });
      child = created.session;
      return {
        id: input.id,
        index: 0,
        agent: input.agent.name,
        agentSource: "project",
        task: input.task,
        exitCode: 0,
        output: "",
        stderr: "",
        truncated: false,
        durationMs: 0,
        tokens: 0,
        requests: 0,
        structuredOutput: {
          source: "caller",
          mode: "strict",
          status: "valid",
          data: { summary: "Clean", findings: [] },
        },
      };
    });
    try {
      const common = {
        ctx: session.extensionRunner!.createContext(),
        directive: "Preserve candidate.",
        assignment: "Inspect candidate.",
        brief: {
          context: "Candidate",
          fixedDecisions: [],
          acceptance: ["Unchanged"],
          model: "review-local/worker",
        },
        root: directory,
        worktree: directory,
        files: ["candidate.txt"],
        signal: new AbortController().signal,
        onProgress: () => {},
      };
      const invocation =
        role === "reviewer"
          ? runReviewer({
              ...common,
              model: registry.find("review-test", "reviewer")!,
              patch: "patch",
              pass: 1,
              previous: [],
            })
          : runWorker({ ...common, model: registry.find("review-local", "worker")! });
      const failure: unknown = await invocation.then(
        () => null,
        (error) => error,
      );
      expect(await fs.stat(sentinel).catch(() => undefined)).toBeUndefined();
      expect(failure).toBeInstanceOf(Error);
      if (failure instanceof Error) expect(failure.message).toContain("command");
    } finally {
      intercept.mockRestore();
      await child?.dispose();
      await session.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);

test("reviewer refuses missing, permissive, noisy, failed and semantically invalid SDK results", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-review-output-"));
  const { session, registry } = await setup(directory);
  const valid: sdk.SingleResult["structuredOutput"] = {
    source: "caller",
    mode: "strict",
    status: "valid",
    data: { summary: "Clean", findings: [] },
  };
  let variant: Partial<sdk.SingleResult> = {};
  const intercept = spyOn(sdk, "runSubprocess").mockImplementation(async (input) => ({
    id: input.id,
    index: 0,
    agent: input.agent.name,
    agentSource: "project",
    task: input.task,
    exitCode: 0,
    output: '{"summary":"Clean","findings":[]}',
    stderr: "",
    truncated: false,
    durationMs: 0,
    tokens: 0,
    requests: 0,
    structuredOutput: valid,
    ...variant,
  }));
  try {
    const variants: Partial<sdk.SingleResult>[] = [
      { structuredOutput: undefined },
      { structuredOutput: { ...valid, mode: "permissive" } },
      { structuredOutput: { ...valid, status: "invalid" } },
      { stderr: "schema warning" },
      { exitCode: 1 },
      {
        structuredOutput: {
          ...valid,
          data: { summary: "Bug", findings: [{ ...finding, file: "context.txt" }] },
        },
      },
    ];
    for (variant of variants) {
      const invocation = runReviewer({
        ctx: session.extensionRunner!.createContext(),
        model: registry.find("review-test", "reviewer")!,
        directive: "Fix default",
        assignment: "Fix",
        brief: {
          context: "Default",
          fixedDecisions: [],
          acceptance: [],
          model: "review-test/parent",
        },
        root: directory,
        worktree: directory,
        files: ["candidate.txt"],
        patch: "patch",
        pass: 1,
        previous: [],
        signal: new AbortController().signal,
        onProgress: () => {},
      });
      await expect(invocation).rejects.toBeInstanceOf(ReviewerError);
    }
  } finally {
    intercept.mockRestore();
    await session.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
