import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runVerification } from "../verification";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(script: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-verify-test-"));
  roots.push(root);
  await fs.writeFile(path.join(root, "verify.cjs"), script);
  return {
    root,
    cwd: root,
    config: { argv: [process.execPath, "verify.cjs"], timeoutMs: 5000 },
    signal: new AbortController().signal,
  };
}

test("verification reports real failures while isolating ordinary generated artifacts", async () => {
  const input = await fixture(
    `const fs = require('node:fs'); fs.writeFileSync('source.txt', 'test mutation'); fs.writeFileSync('generated.txt', 'artifact'); console.error('assertion failed'); process.exit(7);`,
  );
  await fs.writeFile(path.join(input.root, "source.txt"), "candidate bytes");
  const report = await runVerification(input);
  expect(report.status).toBe("failed");
  expect(report.exitCode).toBe(7);
  expect(report.output).toContain("assertion failed");
  expect(await fs.readFile(path.join(input.root, "source.txt"), "utf8")).toBe("candidate bytes");
  expect(
    await fs.stat(path.join(input.root, "generated.txt")).catch(() => undefined),
  ).toBeUndefined();
});

test("argv is passed literally without implicit shell expansion", async () => {
  const input = await fixture(`console.log(JSON.stringify(process.argv.slice(2)));`);
  const args = ["a b", "$(touch escaped)", "", "*.ts", "; exit 9"];
  input.config.argv.push(...args);
  const report = await runVerification(input);
  expect(report.status).toBe("passed");
  expect(JSON.parse(report.output)).toEqual(args);
});

test("verification captures bounded output without deadlocking noisy programs", async () => {
  const input = await fixture(
    `process.stdout.write('x'.repeat(200000)); process.stderr.write('y'.repeat(200000));`,
  );
  const report = await runVerification(input);
  expect(report.status).toBe("passed");
  expect(report.output.length).toBe(65536);
  expect(report.truncated).toBe(true);
});

test.each(["cancelled", "timed-out"] as const)(
  "%s verification stops an ordinary descendant before return",
  async (status) => {
    const sentinel = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "conduct-verify-child-")),
      "sentinel",
    );
    roots.push(path.dirname(sentinel));
    const input = await fixture(
      `const {spawn}=require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'escaped'), 700);`)}], {stdio:'inherit'}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    input.signal = controller.signal;
    input.config.timeoutMs = status === "timed-out" ? 100 : 5000;
    const timer = status === "cancelled" ? setTimeout(() => controller.abort(), 100) : undefined;
    try {
      const report = await runVerification(input);
      expect(report.status).toBe(status);
      await delay(750);
      expect(await fs.stat(sentinel).catch(() => undefined)).toBeUndefined();
    } finally {
      clearTimeout(timer);
    }
  },
);

test("verification settles leftover child processes even after a successful leader exit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-verify-leftover-"));
  roots.push(directory);
  const sentinel = path.join(directory, "sentinel");
  const input = await fixture(
    `const {spawn}=require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'late'), 700);`)}], {stdio:'inherit'}); process.exit(0);`,
  );
  const report = await runVerification(input);
  expect(report.status).toBe("passed");
  await delay(750);
  expect(await fs.stat(sentinel).catch(() => undefined)).toBeUndefined();
});

test("an already cancelled invocation never executes its command", async () => {
  const input = await fixture(`throw new Error('must not execute');`);
  input.signal = AbortSignal.abort(new Error("cancel before verification"));
  await expect(runVerification(input)).rejects.toThrow("cancel before verification");
});
