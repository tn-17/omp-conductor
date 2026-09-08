import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupIsolation } from "@oh-my-pi/pi-coding-agent/task/worktree";
import {
  applyCandidate,
  finishCandidate,
  inspectCandidate,
  listCandidates,
  prepareCandidate,
  recoverCandidates,
  rejectCandidate,
  type PreparedCandidate,
} from "../candidates";

const directories: string[] = [];
const snapshots: PreparedCandidate[] = [];
afterEach(async () => {
  for (const snapshot of snapshots.splice(0)) {
    if (await fs.stat(snapshot.worktree).catch(() => null))
      await cleanupIsolation(snapshot.isolation);
  }
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Conduct Test",
      GIT_AUTHOR_EMAIL: "conduct@example.invalid",
      GIT_COMMITTER_NAME: "Conduct Test",
      GIT_COMMITTER_EMAIL: "conduct@example.invalid",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout;
}
async function workspace(): Promise<{ root: string; storeDir: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-candidate-"));
  directories.push(directory);
  const root = path.join(directory, "repo");
  await fs.mkdir(root);
  await git(root, "init", "--quiet");
  await fs.writeFile(path.join(root, "source.txt"), "original\n");
  await fs.writeFile(path.join(root, "other.txt"), "other\n");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "baseline");
  return { root, storeDir: path.join(directory, "candidates") };
}
async function prepare(
  root: string,
  storeDir: string,
  files = ["source.txt"],
): Promise<PreparedCandidate> {
  const prepared = await prepareCandidate({
    cwd: root,
    storeDir,
    files,
    directive: "implement",
    assignment: "change exact scope",
  });
  snapshots.push(prepared);
  return prepared;
}
async function ready(
  root: string,
  storeDir: string,
  files = ["source.txt"],
): Promise<{ id: string; reviewToken: string }> {
  const prepared = await prepare(root, storeDir, files);
  await fs.writeFile(path.join(prepared.worktree, "source.txt"), "candidate\n");
  const record = await finishCandidate(prepared, { status: "completed" });
  expect(record.status).toBe("ready");
  const review = await inspectCandidate(storeDir, root, record.id);
  return { id: record.id, reviewToken: review.reviewToken! };
}

test("snapshot includes staged, unstaged and untracked bytes and later source edits cannot enter the worker", async () => {
  const { root, storeDir } = await workspace();
  await fs.writeFile(path.join(root, "source.txt"), "staged\n");
  await git(root, "add", "source.txt");
  await fs.writeFile(path.join(root, "source.txt"), "dirty\n");
  await fs.writeFile(path.join(root, "untracked.txt"), "unsaved to Git\n");
  const originalIndex = await fs.readFile(path.join(root, ".git", "index"));
  const originalHead = await git(root, "rev-parse", "HEAD");
  const prepared = await prepare(root, storeDir);
  expect(await fs.readFile(path.join(prepared.worktree, "source.txt"), "utf8")).toBe("dirty\n");
  expect(await fs.readFile(path.join(prepared.worktree, "untracked.txt"), "utf8")).toBe(
    "unsaved to Git\n",
  );
  await fs.writeFile(path.join(root, "other.txt"), "new unrelated source work\n");
  expect(await fs.readFile(path.join(prepared.worktree, "other.txt"), "utf8")).toBe("other\n");
  await fs.writeFile(path.join(prepared.worktree, "source.txt"), "dirty\ncandidate\n");
  expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe("dirty\n");
  const record = await finishCandidate(prepared, { status: "completed" });
  const review = await inspectCandidate(storeDir, root, record.id);
  expect(review.patch).toContain("+candidate");
  expect((await applyCandidate(storeDir, root, record.id, review.reviewToken!)).status).toBe(
    "applied",
  );
  expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe("dirty\ncandidate\n");
  expect(await fs.readFile(path.join(root, "other.txt"), "utf8")).toBe(
    "new unrelated source work\n",
  );
  expect(await fs.readFile(path.join(root, "untracked.txt"), "utf8")).toBe("unsaved to Git\n");
  expect(await fs.readFile(path.join(root, ".git", "index"))).toEqual(originalIndex);
  expect(await git(root, "rev-parse", "HEAD")).toBe(originalHead);
});

test("changed scope bytes make the whole candidate stale before any file is written", async () => {
  const { root, storeDir } = await workspace();
  const prepared = await prepare(root, storeDir, ["source.txt", "other.txt"]);
  await fs.writeFile(path.join(prepared.worktree, "source.txt"), "candidate\n");
  await fs.writeFile(path.join(prepared.worktree, "other.txt"), "candidate other\n");
  const record = await finishCandidate(prepared, { status: "completed" });
  const review = await inspectCandidate(storeDir, root, record.id);
  await fs.writeFile(path.join(root, "other.txt"), "human\n");
  expect((await applyCandidate(storeDir, root, record.id, review.reviewToken!)).status).toBe(
    "stale",
  );
  expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe("original\n");
  expect(await fs.readFile(path.join(root, "other.txt"), "utf8")).toBe("human\n");
});

test("a new-file collision is stale even when another scope file would apply", async () => {
  const { root, storeDir } = await workspace();
  const prepared = await prepare(root, storeDir, ["source.txt", "new.txt"]);
  await fs.writeFile(path.join(prepared.worktree, "source.txt"), "candidate\n");
  await fs.writeFile(path.join(prepared.worktree, "new.txt"), "worker new\n");
  const record = await finishCandidate(prepared, { status: "completed" });
  const review = await inspectCandidate(storeDir, root, record.id);
  await fs.writeFile(path.join(root, "new.txt"), "human new\n");
  expect((await applyCandidate(storeDir, root, record.id, review.reviewToken!)).status).toBe(
    "stale",
  );
  expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe("original\n");
  expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("human new\n");
});

test("mode changes on even unchanged scope files invalidate the candidate", async () => {
  const { root, storeDir } = await workspace();
  const candidate = await ready(root, storeDir, ["source.txt", "other.txt"]);
  await fs.chmod(path.join(root, "other.txt"), 0o755);
  expect((await applyCandidate(storeDir, root, candidate.id, candidate.reviewToken)).status).toBe(
    "stale",
  );
  expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe("original\n");
});

test("replacing a parent with a symlink cannot redirect an application", async () => {
  const { root, storeDir } = await workspace();
  await fs.mkdir(path.join(root, "sub"));
  await fs.writeFile(path.join(root, "sub", "file.txt"), "original\n");
  const prepared = await prepare(root, storeDir, ["source.txt", "sub/file.txt"]);
  await fs.writeFile(path.join(prepared.worktree, "source.txt"), "candidate\n");
  await fs.writeFile(path.join(prepared.worktree, "sub", "file.txt"), "worker\n");
  const record = await finishCandidate(prepared, { status: "completed" });
  const review = await inspectCandidate(storeDir, root, record.id);
  await fs.rename(path.join(root, "sub"), path.join(root, "moved"));
  await fs.symlink("moved", path.join(root, "sub"));
  expect((await applyCandidate(storeDir, root, record.id, review.reviewToken!)).status).toBe(
    "stale",
  );
  expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe("original\n");
  expect(await fs.readFile(path.join(root, "moved", "file.txt"), "utf8")).toBe("original\n");
});

test("out-of-scope writes are retained but never applicable", async () => {
  const { root, storeDir } = await workspace();
  const prepared = await prepare(root, storeDir);
  await fs.writeFile(path.join(prepared.worktree, "source.txt"), "candidate\n");
  await fs.writeFile(path.join(prepared.worktree, "other.txt"), "worker outside scope\n");
  const record = await finishCandidate(prepared, { status: "completed" });
  expect(record.status).toBe("failed");
  const review = await inspectCandidate(storeDir, root, record.id);
  expect(review.patch).toContain("+worker outside scope");
  expect(review.reviewToken).toBeUndefined();
  await expect(applyCandidate(storeDir, root, record.id, "anything")).rejects.toThrow(
    "not applicable",
  );
  expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe("original\n");
});

test("ignored scope is explicit while unrelated ignored content is not retained or applied", async () => {
  const { root, storeDir } = await workspace();
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\ncache.txt\n");
  await fs.writeFile(path.join(root, "ignored.txt"), "explicit baseline\n");
  await fs.writeFile(path.join(root, "cache.txt"), "private cache\n");
  const prepared = await prepare(root, storeDir, ["ignored.txt"]);
  await fs.writeFile(path.join(prepared.worktree, "ignored.txt"), "explicit candidate\n");
  await fs.writeFile(path.join(prepared.worktree, "cache.txt"), "worker cache\n");
  const record = await finishCandidate(prepared, { status: "completed" });
  expect(record.status).toBe("ready");
  const review = await inspectCandidate(storeDir, root, record.id);
  expect(review.patch).toContain("+explicit candidate");
  expect(review.patch).not.toContain("cache.txt");
  expect((await applyCandidate(storeDir, root, record.id, review.reviewToken!)).status).toBe(
    "applied",
  );
  expect(await fs.readFile(path.join(root, "ignored.txt"), "utf8")).toBe("explicit candidate\n");
  expect(await fs.readFile(path.join(root, "cache.txt"), "utf8")).toBe("private cache\n");
  expect(await fs.stat(path.join(storeDir, record.id, "git")).catch(() => null)).toBeNull();
});

test("retained patch tampering and scope tampering invalidate prior approval", async () => {
  const { root, storeDir } = await workspace();
  const first = await ready(root, storeDir);
  const review = await inspectCandidate(storeDir, root, first.id);
  await fs.appendFile(review.candidate.patchPath, "\n# tampered\n");
  await expect(applyCandidate(storeDir, root, first.id, first.reviewToken)).rejects.toThrow(
    "artifacts were modified",
  );
  const second = await ready(root, storeDir);
  const filename = path.join(storeDir, second.id, "record.json");
  const record = JSON.parse(await fs.readFile(filename, "utf8"));
  record.assignment = "different candidate identity";
  await fs.writeFile(filename, JSON.stringify(record));
  await expect(applyCandidate(storeDir, root, second.id, second.reviewToken)).rejects.toThrow(
    "Review token",
  );
  expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe("original\n");
});

test("binary modification, binary addition, deletion and executable modes apply without staging", async () => {
  const { root, storeDir } = await workspace();
  await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2, 255]));
  const index = await fs.readFile(path.join(root, ".git", "index"));
  const prepared = await prepare(root, storeDir, [
    "source.txt",
    "other.txt",
    "binary.dat",
    "new binary.dat",
  ]);
  await fs.unlink(path.join(prepared.worktree, "source.txt"));
  await fs.chmod(path.join(prepared.worktree, "other.txt"), 0o755);
  await fs.writeFile(path.join(prepared.worktree, "binary.dat"), Buffer.from([0, 255, 4, 128]));
  await fs.writeFile(path.join(prepared.worktree, "new binary.dat"), Buffer.from([0, 8, 255, 9]));
  const record = await finishCandidate(prepared, { status: "completed" });
  const review = await inspectCandidate(storeDir, root, record.id);
  expect(review.patch).toContain("GIT binary patch");
  expect((await applyCandidate(storeDir, root, record.id, review.reviewToken!)).status).toBe(
    "applied",
  );
  expect(await fs.stat(path.join(root, "source.txt")).catch(() => null)).toBeNull();
  expect((await fs.stat(path.join(root, "other.txt"))).mode & 0o777).toBe(0o755);
  expect(await fs.readFile(path.join(root, "binary.dat"))).toEqual(Buffer.from([0, 255, 4, 128]));
  expect(await fs.readFile(path.join(root, "new binary.dat"))).toEqual(Buffer.from([0, 8, 255, 9]));
  expect(await fs.readFile(path.join(root, ".git", "index"))).toEqual(index);
});

test("non-NUL invalid UTF-8 additions apply the exact reviewed bytes", async () => {
  const { root, storeDir } = await workspace();
  const prepared = await prepare(root, storeDir, ["raw.dat"]);
  const bytes = Buffer.from([0xff, 0xfe, 0x61, 0x0a, 0x80, 0x0a]);
  await fs.writeFile(path.join(prepared.worktree, "raw.dat"), bytes);
  const record = await finishCandidate(prepared, { status: "completed" });
  expect(record.status).toBe("ready");
  const retained = await fs.readFile(record.patchPath);
  expect(retained.includes(bytes.subarray(0, 4))).toBe(true);
  const review = await inspectCandidate(storeDir, root, record.id);
  expect((await applyCandidate(storeDir, root, record.id, review.reviewToken!)).status).toBe(
    "applied",
  );
  expect(await fs.readFile(path.join(root, "raw.dat"))).toEqual(bytes);
});

test("working-tree encoding changes cannot recode an added candidate file", async () => {
  const { root, storeDir } = await workspace();
  await fs.writeFile(path.join(root, ".gitattributes"), "*.utf16 working-tree-encoding=UTF-16LE\n");
  const prepared = await prepare(root, storeDir, ["new.utf16"]);
  const bytes = Buffer.from("worker bytes\n", "utf16le");
  await fs.writeFile(path.join(prepared.worktree, "new.utf16"), bytes);
  const record = await finishCandidate(prepared, { status: "completed" });
  expect(record.status).toBe("ready");
  const review = await inspectCandidate(storeDir, root, record.id);
  await fs.writeFile(path.join(root, ".gitattributes"), "*.utf16 working-tree-encoding=UTF-16BE\n");
  expect((await applyCandidate(storeDir, root, record.id, review.reviewToken!)).status).toBe(
    "applied",
  );
  expect(await fs.readFile(path.join(root, "new.utf16"))).toEqual(bytes);
});

test("a special-mode-only scope mutation fails beside a normal change and retains the snapshot", async () => {
  const { root, storeDir } = await workspace();
  const prepared = await prepare(root, storeDir, ["source.txt", "other.txt"]);
  await fs.writeFile(path.join(prepared.worktree, "source.txt"), "candidate\n");
  await fs.chmod(path.join(prepared.worktree, "other.txt"), 0o4644);
  const record = await finishCandidate(prepared, { status: "completed" });
  expect(record.status).toBe("failed");
  expect(await fs.readFile(path.join(prepared.worktree, "source.txt"), "utf8")).toBe("candidate\n");
  expect((await fs.stat(path.join(prepared.worktree, "other.txt"))).mode & 0o7777).toBe(0o4644);
  const review = await inspectCandidate(storeDir, root, record.id);
  expect(review.reviewToken).toBeUndefined();
  await expect(applyCandidate(storeDir, root, record.id, "")).rejects.toThrow();
  expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe("original\n");
  expect((await fs.stat(path.join(root, "other.txt"))).mode & 0o7777).toBe(0o644);
});

test("source attributes cannot normalize the reviewed candidate bytes", async () => {
  const { root, storeDir } = await workspace();
  await fs.writeFile(path.join(root, ".gitattributes"), "*.txt text eol=lf\n");
  await fs.writeFile(path.join(root, "source.txt"), "original  \r\n\r\n\r\nend\t\r\n");
  const readOnlyContext = "preserve readonly context  \r\n\r\nend\r\n";
  await fs.writeFile(path.join(root, "other.txt"), readOnlyContext);
  const prepared = await prepare(root, storeDir);
  expect(await fs.readFile(path.join(prepared.worktree, "other.txt"), "utf8")).toBe(
    readOnlyContext,
  );
  const candidateText = "changed  \r\n\r\n\r\nend\t\r\n";
  await fs.writeFile(path.join(prepared.worktree, "source.txt"), candidateText);
  const record = await finishCandidate(prepared, { status: "completed" });
  const review = await inspectCandidate(storeDir, root, record.id);
  expect((await applyCandidate(storeDir, root, record.id, review.reviewToken!)).status).toBe(
    "applied",
  );
  expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe(candidateText);
});

test("changed Git metadata fails before capture and preserves the actual worker files", async () => {
  const { root, storeDir } = await workspace();
  const prepared = await prepare(root, storeDir);
  await fs.writeFile(
    path.join(prepared.worktree, "source.txt"),
    "recoverable worker implementation\n",
  );
  await fs.appendFile(path.join(prepared.worktree, ".git", "config"), "\n[malformed");
  const record = await finishCandidate(prepared, { status: "completed" });
  expect(record.status).toBe("failed");
  expect(record.error).toContain("Worker changed Git metadata");
  expect(await fs.readFile(path.join(prepared.worktree, "source.txt"), "utf8")).toBe(
    "recoverable worker implementation\n",
  );
  expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe("original\n");
  expect((await inspectCandidate(storeDir, root, record.id)).reviewToken).toBeUndefined();
});

test("a completed worker without a delta cannot produce an applicable candidate", async () => {
  const { root, storeDir } = await workspace();
  const prepared = await prepare(root, storeDir);
  const record = await finishCandidate(prepared, { status: "completed" });
  expect(record.status).toBe("rejected");
  expect((await inspectCandidate(storeDir, root, record.id)).reviewToken).toBeUndefined();
  await expect(applyCandidate(storeDir, root, record.id, "anything")).rejects.toThrow(
    "not applicable",
  );
});

test("cancellation retains partial work and rejection removes application authority", async () => {
  const { root, storeDir } = await workspace();
  const prepared = await prepare(root, storeDir);
  await fs.writeFile(path.join(prepared.worktree, "source.txt"), "partial\n");
  const cancelled = await finishCandidate(prepared, { status: "cancelled" });
  expect(cancelled.status).toBe("cancelled");
  expect((await inspectCandidate(storeDir, root, cancelled.id)).patch).toContain("+partial");
  await expect(applyCandidate(storeDir, root, cancelled.id, "anything")).rejects.toThrow(
    "not applicable",
  );
  const candidate = await ready(root, storeDir);
  expect((await rejectCandidate(storeDir, root, candidate.id)).status).toBe("rejected");
  expect((await inspectCandidate(storeDir, root, candidate.id)).patch).toContain("+candidate");
  await expect(applyCandidate(storeDir, root, candidate.id, candidate.reviewToken)).rejects.toThrow(
    "not applicable",
  );
});

test("restart recovery does not dispatch or apply orphaned running and applying candidates", async () => {
  const { root, storeDir } = await workspace();
  const running = await prepare(root, storeDir);
  await fs.writeFile(path.join(running.worktree, "source.txt"), "orphaned worker\n");
  const applying = await ready(root, storeDir);
  const filename = path.join(storeDir, applying.id, "record.json");
  const record = JSON.parse(await fs.readFile(filename, "utf8"));
  record.status = "applying";
  await fs.writeFile(filename, JSON.stringify(record));
  await recoverCandidates(storeDir, root);
  const records = await listCandidates(storeDir, root);
  expect(records.find((item) => item.id === running.candidate.id)?.status).toBe("failed");
  expect(records.find((item) => item.id === applying.id)?.error).toContain("partially changed");
  await expect(applyCandidate(storeDir, root, applying.id, applying.reviewToken)).rejects.toThrow(
    "not applicable",
  );
  expect(await fs.readFile(path.join(root, "source.txt"), "utf8")).toBe("original\n");
});

test("invalid scope, nested repositories and foreign stores fail closed before dispatch", async () => {
  const { root, storeDir } = await workspace();
  await expect(prepare(root, storeDir, ["../escape"])).rejects.toThrow("traversal");
  await expect(prepare(root, storeDir, ["*.txt"])).rejects.toThrow("globs");
  await expect(prepare(root, storeDir, [".git/config"])).rejects.toThrow("metadata");
  await fs.symlink("source.txt", path.join(root, "link"));
  await expect(prepare(root, storeDir, ["link"])).rejects.toThrow("Symlink");
  const candidate = await ready(root, storeDir);
  const other = await workspace();
  await expect(inspectCandidate(storeDir, other.root, candidate.id)).rejects.toThrow("repository");
  await expect(inspectCandidate(other.storeDir, root, candidate.id)).rejects.toThrow();
  await fs.mkdir(path.join(root, "nested"));
  await git(path.join(root, "nested"), "init", "--quiet");
  await expect(prepare(root, storeDir)).rejects.toThrow();
});
