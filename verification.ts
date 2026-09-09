import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { VerificationConfig, VerificationReport } from "./review-types";

const outputLimit = 64 * 1024;

// The SDK command parser drops quoted empty tokens. Verification needs exact
// argv, with quoting/escaping but no shell expansion or interpretation.
export function parseVerificationArgs(source: string): string[] {
  const args: string[] = [];
  let token = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (char === "\\" && quote !== "'") {
      const next = source[index + 1];
      if (next === undefined) throw new Error("Incomplete verification argument escape.");
      if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(next)) {
        token += char;
      } else {
        index++;
        if (next !== "\n") token += next;
      }
      started = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(token);
      token = "";
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unterminated verification argument quote.");
  if (started) args.push(token);
  return args;
}

export function validateVerification(config: VerificationConfig): void {
  if (
    !config ||
    !Array.isArray(config.argv) ||
    !config.argv.length ||
    typeof config.argv[0] !== "string" ||
    !config.argv[0].trim() ||
    config.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 1 ||
    config.timeoutMs > 1_800_000
  )
    throw new Error(
      "Verification requires an exact executable/argument list and a timeout between 1 and 1800000 milliseconds.",
    );
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function execute(
  cwd: string,
  config: VerificationConfig,
  signal: AbortSignal,
): Promise<VerificationReport> {
  signal.throwIfAborted();
  const started = performance.now();
  const output = Buffer.allocUnsafe(outputLimit);
  let used = 0;
  let truncated = false;
  const append = (chunk: Buffer) => {
    const count = Math.min(chunk.length, outputLimit - used);
    chunk.copy(output, used, 0, count);
    used += count;
    truncated ||= count < chunk.length;
  };
  const child = spawn(config.argv[0]!, config.argv.slice(1), {
    cwd,
    env: { ...process.env, PWD: cwd, INIT_CWD: cwd },
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let requested: "cancelled" | "timed-out" | undefined;
  let spawnError: Error | undefined;
  let killError: unknown;
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: "cancelled" | "timed-out") => {
    requested ??= reason;
    if (!child.pid) return;
    try {
      killGroup(child.pid, "SIGTERM");
    } catch (error) {
      killError ??= error;
    }
    hardStop ??= setTimeout(() => {
      if (!child.pid) return;
      try {
        killGroup(child.pid, "SIGKILL");
      } catch (error) {
        killError ??= error;
      }
    }, 250);
  };
  const onAbort = () => stop("cancelled");
  const timeout = setTimeout(() => stop("timed-out"), config.timeoutMs);
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const terminal = new Promise<{ status: VerificationReport["status"]; exitCode: number | null }>(
    (resolve) => {
      const finish = (exitCode: number | null) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        resolve({ status: requested ?? (exitCode === 0 ? "passed" : "failed"), exitCode });
      };
      child.once("error", (error) => {
        spawnError = error;
        finish(null);
      });
      child.once("exit", (code) => finish(code));
    },
  );
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const outcome = await terminal;
    // The leader can exit while ordinary descendants still hold pipes or write
    // test artifacts. Settle its process group before removing the copy. This
    // is lifecycle cleanup, not containment of hostile processes.
    if (child.pid) {
      killGroup(child.pid, "SIGTERM");
      for (let attempt = 0; attempt < 10 && groupExists(child.pid); attempt++) await delay(25);
      if (groupExists(child.pid)) killGroup(child.pid, "SIGKILL");
    }
    // A deliberately detached descendant can escape its group in trusted mode.
    // Do not let an inherited pipe keep the invocation alive indefinitely.
    let pipeTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          pipeTimeout = setTimeout(resolve, 500);
        }),
      ]);
    } finally {
      clearTimeout(pipeTimeout);
    }
    child.stdout.destroy();
    child.stderr.destroy();
    if (spawnError) throw new Error(`Unable to start trusted verification: ${spawnError.message}`);
    if (killError) throw killError;
    return {
      argv: [...config.argv],
      status: outcome.status,
      exitCode: outcome.exitCode,
      output: output.subarray(0, used).toString("utf8"),
      truncated,
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timeout);
    clearTimeout(hardStop);
    signal.removeEventListener("abort", onAbort);
    if (child.pid) killGroup(child.pid, "SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

/** Trusted host execution, NOT a sandbox. Only ordinary artifact writes are isolated. */
export async function runVerification(input: {
  root: string;
  cwd: string;
  config: VerificationConfig;
  signal: AbortSignal;
}): Promise<VerificationReport> {
  validateVerification(input.config);
  input.signal.throwIfAborted();
  if (process.platform === "win32")
    throw new Error("Trusted verification currently requires POSIX process-group cleanup.");
  const root = await fs.realpath(input.root);
  const cwd = await fs.realpath(input.cwd);
  const relative = path.relative(root, cwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Verification working directory must stay inside the candidate snapshot.");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-verify-"));
  const snapshot = path.join(directory, "snapshot");
  try {
    await fs.cp(root, snapshot, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (source) => {
        input.signal.throwIfAborted();
        return source === root || path.basename(source) !== ".git";
      },
    });
    input.signal.throwIfAborted();
    return await execute(path.join(snapshot, relative), input.config, input.signal);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
