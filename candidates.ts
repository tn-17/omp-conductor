import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { IsoBackendKind } from "@oh-my-pi/pi-natives";
import {
  cleanupIsolation,
  ensureIsolation,
  getRepoRoot,
  type IsolationHandle,
} from "@oh-my-pi/pi-coding-agent/task/worktree";

export type CandidateStatus =
  | "running"
  | "ready"
  | "failed"
  | "cancelled"
  | "rejected"
  | "stale"
  | "applying"
  | "applied";
type FileState = { kind: "absent" } | { kind: "file"; hash: string; mode: number };
export interface CandidateBrief {
  readonly context: string;
  readonly fixedDecisions: readonly string[];
  readonly acceptance: readonly string[];
  readonly model: string;
}
export interface CandidateRecord {
  version: 1;
  id: string;
  root: string;
  cwd: string;
  files: string[];
  status: CandidateStatus;
  createdAt: string;
  directive: string;
  assignment: string;
  brief?: CandidateBrief;
  changes: string[];
  patchPath: string;
  reviewToken?: string;
  error?: string;
  worker?: { status: string; model?: string; id?: string; outputPath?: string };
  baseline: Record<string, FileState>;
  baselineTree: string;
  finalTree?: string;
  patchHash: string;
}
export interface PreparedCandidate {
  candidate: CandidateRecord;
  worktree: string;
  workerCwd: string;
  storeDir: string;
  isolation: IsolationHandle;
  metadata: string;
  manifest: string;
}
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const statuses: Record<CandidateStatus, true> = {
  running: true,
  ready: true,
  failed: true,
  cancelled: true,
  rejected: true,
  stale: true,
  applying: true,
  applied: true,
};
function relative(root: string, filename: string): string {
  const result = path.relative(root, filename);
  if (!result || result === ".." || result.startsWith(`..${path.sep}`) || path.isAbsolute(result))
    throw new Error("Candidate files must be inside the Git repository");
  if (result.split(path.sep).some((part) => part.toLowerCase() === ".git"))
    throw new Error("Git metadata is not writable candidate scope");
  return result;
}
async function rootFor(cwd: string): Promise<string> {
  try {
    return await fs.realpath(await getRepoRoot(cwd));
  } catch {
    throw new Error(
      "Conduct candidates require an existing Git repository; initialize it explicitly first",
    );
  }
}
async function state(root: string, file: string): Promise<FileState> {
  relative(root, path.resolve(root, file));
  const parts = file.split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlink path is unsupported: ${file}`);
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) throw new Error(`Non-directory path component: ${file}`);
      if (
        await fs.lstat(path.join(current, ".git")).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        })
      )
        throw new Error(`Nested repository scope is unsupported: ${file}`);
    } else {
      if (!stat.isFile())
        throw new Error(`Scope must name an exact regular file or absent file: ${file}`);
      const mode = stat.mode & 0o7777;
      if (mode !== 0o644 && mode !== 0o755)
        throw new Error(`Unsupported file permissions (only 0644/0755 are applicable): ${file}`);
      return { kind: "file", hash: digest(await fs.readFile(current)), mode };
    }
  }
  throw new Error("Empty candidate path");
}
async function scanMetadata(root: string): Promise<string> {
  const entries: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const name = prefix ? `${prefix}/${child.name}` : child.name;
      const full = path.join(directory, child.name);
      if (child.isDirectory()) await walk(full, name);
      else if (child.isSymbolicLink()) entries.push(`${name}\0link\0${await fs.readlink(full)}`);
      else if (child.isFile()) {
        const stat = await fs.stat(full);
        entries.push(`${name}\0${stat.mode & 0o7777}\0${digest(await fs.readFile(full))}`);
      } else throw new Error(`Special filesystem entry is unsupported: ${name}`);
    }
  }
  await walk(root, "");
  return JSON.stringify(entries);
}
function location(store: string, id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id)) throw new Error("Invalid candidate id");
  return path.join(path.resolve(store), id);
}
async function gitRaw(
  gitDir: string,
  worktree: string | undefined,
  args: string[],
  input?: string | Buffer,
): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  Object.assign(env, {
    GIT_DIR: gitDir,
    GIT_INDEX_FILE: path.join(gitDir, "index"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_LITERAL_PATHSPECS: "1",
  });
  if (worktree !== undefined) env.GIT_WORK_TREE = worktree;
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "core.bare=false",
      "-c",
      "core.filemode=true",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    {
      cwd: worktree ?? gitDir,
      env,
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Git ${args[0]} failed: ${stderr.trim()}`);
  return Buffer.from(stdout);
}
async function git(
  gitDir: string,
  worktree: string | undefined,
  args: string[],
  input?: string | Buffer,
): Promise<string> {
  return utf8.decode(await gitRaw(gitDir, worktree, args, input));
}
async function save(store: string, record: CandidateRecord): Promise<void> {
  const filename = path.join(location(store, record.id), "record.json");
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
  await fs.rename(temporary, filename);
}
async function load(store: string, cwd: string, id: string): Promise<CandidateRecord> {
  const directory = location(store, id);
  const record = JSON.parse(
    await fs.readFile(path.join(directory, "record.json"), "utf8"),
  ) as CandidateRecord;
  if (
    record.version !== 1 ||
    record.id !== id ||
    record.root !== (await rootFor(cwd)) ||
    !Object.hasOwn(statuses, record.status) ||
    record.patchPath !== path.join(directory, "candidate.patch") ||
    !Array.isArray(record.files) ||
    !Array.isArray(record.changes) ||
    !record.baseline
  )
    throw new Error("Invalid candidate identity or repository");
  if (new Set(record.files).size !== record.files.length || !record.files.length)
    throw new Error("Invalid candidate scope");
  for (const file of record.files) {
    if (
      typeof file !== "string" ||
      relative(record.root, path.resolve(record.root, file)) !== file ||
      !record.baseline[file]
    )
      throw new Error("Invalid candidate scope or baseline");
  }
  return record;
}
async function copySavedBytes(root: string, worktree: string, files: string[]): Promise<void> {
  const gitDir = path.join(worktree, ".git");
  const listed = await git(gitDir, worktree, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  for (const file of new Set([...listed.split("\0").filter(Boolean), ...files])) {
    relative(root, path.resolve(root, file));
    const source = path.join(root, file);
    const stat = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const destination = path.join(worktree, file);
    let parent = worktree;
    for (const part of file.split(path.sep).slice(0, -1)) {
      parent = path.join(parent, part);
      const entry = await fs.lstat(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
        throw new Error(`Unsafe snapshot path component: ${file}`);
      if (!entry) await fs.mkdir(parent);
    }
    const target = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (target && !target.isFile() && !target.isSymbolicLink())
      throw new Error(`Unsupported snapshot entry: ${file}`);
    if (!stat) {
      if (target) await fs.unlink(destination);
    } else if (stat.isFile()) {
      if (target?.isSymbolicLink()) await fs.unlink(destination);
      await fs.copyFile(source, destination, fsConstants.COPYFILE_FICLONE);
      await fs.chmod(destination, stat.mode & 0o7777);
    } else if (stat.isSymbolicLink()) {
      if (target) await fs.unlink(destination);
      await fs.symlink(await fs.readlink(source), destination);
    } else {
      throw new Error(`Unsupported saved source entry: ${file}`);
    }
  }
}

async function tree(gitDir: string, worktree: string, files: string[]): Promise<string> {
  await git(gitDir, worktree, ["add", "--all", "--", "."]);
  for (const file of files) {
    if (await fs.lstat(path.join(worktree, file)).catch(() => null))
      await git(gitDir, worktree, ["add", "--force", "--", file]);
  }
  return (await git(gitDir, worktree, ["write-tree"])).trim();
}
async function manifest(gitDir: string, worktree: string): Promise<string> {
  // Ignored out-of-scope content is deliberately excluded: this is a candidate
  // application gate, not an OS containment or cache-retention mechanism.
  const names = [
    ...new Set(
      (
        await git(gitDir, worktree, [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
        ])
      )
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const entries: string[] = [];
  for (const name of names) {
    const filename = path.join(worktree, name);
    const stat = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink()) entries.push(`${name}\0link\0${await fs.readlink(filename)}`);
    else if (stat.isFile())
      entries.push(`${name}\0${stat.mode & 0o7777}\0${digest(await fs.readFile(filename))}`);
    else
      throw new Error(
        `Nested repositories, directories and special entries are unsupported: ${name}`,
      );
  }
  return JSON.stringify(entries);
}
async function delta(
  gitDir: string,
  worktree: string,
  before: string,
  after: string,
): Promise<{ patch: Buffer; changes: string[] }> {
  if (![before, after].every((value) => /^[a-f0-9]{40,64}$/.test(value)))
    throw new Error("Invalid candidate tree identity");
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", before, after];
  const patch = await gitRaw(gitDir, worktree, [
    ...args,
    "--binary",
    "--full-index",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ]);
  const changes = (await git(gitDir, worktree, [...args, "--name-only", "-z"]))
    .split("\0")
    .filter(Boolean);
  return { patch, changes };
}
function token(record: CandidateRecord, patch: Buffer): string {
  const { reviewToken: _, ...bound } = record;
  const canonical = JSON.stringify(bound, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value))
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, value[key]]),
      );
    return value;
  });
  return createHash("sha256").update(canonical).update("\0").update(patch).digest("hex");
}
async function retained(record: CandidateRecord): Promise<Buffer> {
  const patch = await fs.readFile(record.patchPath);
  if (digest(patch) !== record.patchHash)
    throw new Error("Candidate artifacts were modified; review is invalid");
  if (!record.finalTree && record.status === "ready")
    throw new Error("Candidate has no retained delta");
  return patch;
}
export async function prepareCandidate(input: {
  cwd: string;
  storeDir: string;
  files: string[];
  directive: string;
  assignment: string;
  brief: CandidateBrief;
}): Promise<PreparedCandidate> {
  const meaningful = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  if (
    !input.brief ||
    !meaningful(input.brief.context) ||
    !meaningful(input.brief.model) ||
    !Array.isArray(input.brief.fixedDecisions) ||
    !input.brief.fixedDecisions.every(meaningful) ||
    !Array.isArray(input.brief.acceptance) ||
    !input.brief.acceptance.length ||
    !input.brief.acceptance.every(meaningful)
  )
    throw new Error(
      "Candidate requires meaningful context, fixedDecisions, acceptance, and model.",
    );
  const brief: CandidateBrief = Object.freeze({
    context: input.brief.context,
    fixedDecisions: Object.freeze([...input.brief.fixedDecisions]),
    acceptance: Object.freeze([...input.brief.acceptance]),
    model: input.brief.model,
  });
  const cwd = await fs.realpath(input.cwd);
  const root = await rootFor(cwd);
  const storeDir = path.resolve(input.storeDir);
  if (
    storeDir === root ||
    (!path.relative(root, storeDir).startsWith(`..${path.sep}`) &&
      path.relative(root, storeDir) !== "..")
  )
    throw new Error("Candidate artifact store must be outside the repository");
  if (!input.files.length) throw new Error("Candidate requires exact writable files");
  const files = [
    ...new Set(
      input.files.map((file) => {
        if (
          !file ||
          file.includes("\0") ||
          file.split(/[\\/]/).includes("..") ||
          /[*?[\]{}]/.test(file)
        )
          throw new Error("Candidate scope must use exact paths without traversal or globs");
        return relative(root, path.resolve(cwd, file));
      }),
    ),
  ].sort();
  const sourceStates: Record<string, FileState> = Object.create(null);
  for (const file of files) sourceStates[file] = await state(root, file);
  const id = randomUUID();
  const directory = location(storeDir, id);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let isolation: IsolationHandle | undefined;
  try {
    isolation = await ensureIsolation(root, id, IsoBackendKind.Rcopy);
    if (isolation.backend !== IsoBackendKind.Rcopy)
      throw new Error("Candidate requires a frozen Rcopy snapshot; live-view fallback refused");
    const worktree = isolation.mergedDir;
    const tracked = await git(path.join(worktree, ".git"), worktree, ["ls-files", "--stage", "-z"]);
    if (tracked.split("\0").some((entry) => entry.startsWith("160000 ")))
      throw new Error("Gitlinks are unsupported");
    // Git-backed materialization may normalize attributes or omit ignored scope.
    // Restore saved bytes before freezing the baseline, including read-only marker sources.
    await copySavedBytes(root, worktree, files);
    const baseline: Record<string, FileState> = Object.create(null);
    for (const file of files) {
      const original = sourceStates[file]!;
      baseline[file] = await state(worktree, file);
      if (JSON.stringify(baseline[file]) !== JSON.stringify(original))
        throw new Error(`Source changed while preparing its snapshot: ${file}`);
    }
    const gitDir = path.join(worktree, ".git");
    const trackedPaths = await git(gitDir, worktree, ["ls-files", "-z"]);
    if (trackedPaths)
      await git(
        gitDir,
        worktree,
        ["update-index", "--no-assume-unchanged", "--no-skip-worktree", "-z", "--stdin"],
        trackedPaths,
      );
    await fs.writeFile(
      path.join(gitDir, "info", "attributes"),
      "* -text -filter -ident -working-tree-encoding\n",
    );
    await manifest(gitDir, worktree);
    const baselineTree = await tree(gitDir, worktree, files);
    const initialManifest = await manifest(gitDir, worktree);
    const metadata = await scanMetadata(gitDir);
    const candidate: CandidateRecord = {
      version: 1,
      id,
      root,
      cwd,
      files,
      status: "running",
      createdAt: new Date().toISOString(),
      directive: input.directive,
      assignment: input.assignment,
      brief,
      changes: [],
      patchPath: path.join(directory, "candidate.patch"),
      baseline,
      baselineTree,
      patchHash: digest(""),
    };
    await fs.writeFile(candidate.patchPath, "", { mode: 0o600 });
    await fs.writeFile(path.join(directory, "isolation.json"), JSON.stringify(isolation), {
      mode: 0o600,
    });
    await save(storeDir, candidate);
    return {
      candidate,
      worktree,
      workerCwd: path.join(worktree, path.relative(root, cwd)),
      storeDir,
      isolation,
      metadata,
      manifest: initialManifest,
    };
  } catch (error) {
    if (isolation) await cleanupIsolation(isolation);
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function finishCandidate(
  prepared: PreparedCandidate,
  outcome: {
    status: "completed" | "failed" | "cancelled";
    model?: string;
    id?: string;
    outputPath?: string;
    error?: string;
  },
): Promise<CandidateRecord> {
  const record = prepared.candidate;
  record.worker = {
    status: outcome.status,
    model: outcome.model,
    id: outcome.id,
    outputPath: outcome.outputPath,
  };
  record.status = outcome.status === "completed" ? "ready" : outcome.status;
  record.error = outcome.error;
  let capturedSafely = false;
  try {
    const gitDir = path.join(prepared.worktree, ".git");
    // Never execute Git against configuration or metadata a worker modified.
    if (prepared.metadata !== (await scanMetadata(gitDir)))
      throw new Error("Worker changed Git metadata");
    record.finalTree = await tree(gitDir, prepared.worktree, record.files);
    const captured = await delta(gitDir, prepared.worktree, record.baselineTree, record.finalTree);
    record.changes = captured.changes;
    record.patchHash = digest(captured.patch);
    await fs.writeFile(record.patchPath, captured.patch, { mode: 0o600 });
    const entries = (
      await git(gitDir, prepared.worktree, ["ls-tree", "-r", "-z", record.finalTree])
    ).split("\0");
    if (entries.some((entry) => entry.startsWith("160000 ")))
      throw new Error("Worker introduced an unsupported Gitlink");
    const currentManifest = await manifest(gitDir, prepared.worktree);
    const before = new Map<string, string>(
      (JSON.parse(prepared.manifest) as string[]).map((entry) => [entry.split("\0")[0]!, entry]),
    );
    const after = new Map<string, string>(
      (JSON.parse(currentManifest) as string[]).map((entry) => [entry.split("\0")[0]!, entry]),
    );
    for (const file of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(file) !== after.get(file) && !record.changes.includes(file))
        throw new Error(`Unsupported filesystem-only change: ${file}`);
    }
    for (const file of record.changes) {
      if (!record.files.includes(file))
        throw new Error(`Worker changed out-of-scope file: ${file}`);
      await state(prepared.worktree, file);
    }
    capturedSafely = true;
    if (outcome.status === "completed" && !record.changes.length) {
      record.status = "rejected";
      record.error = "Worker produced no candidate changes.";
    }
  } catch (error) {
    record.status = outcome.status === "cancelled" ? "cancelled" : "failed";
    record.error = [record.error, message(error)].filter(Boolean).join("; ");
  }
  // A failed capture may not represent all worker bytes; preserve its snapshot for recovery.
  if (!capturedSafely)
    record.error = [record.error, `Snapshot retained for inspection: ${prepared.worktree}`]
      .filter(Boolean)
      .join("; ");
  await save(prepared.storeDir, record);
  if (capturedSafely) {
    await cleanupIsolation(prepared.isolation);
    await fs.rm(path.join(location(prepared.storeDir, record.id), "isolation.json"), {
      force: true,
    });
  }
  return record;
}
export async function listCandidates(storeDir: string, cwd: string): Promise<CandidateRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(storeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: CandidateRecord[] = [];
  for (const name of names.sort())
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(name)) records.push(await load(storeDir, cwd, name));
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function inspectCandidate(
  storeDir: string,
  cwd: string,
  id: string,
): Promise<{ candidate: CandidateRecord; patch: string; reviewToken?: string }> {
  const candidate = await load(storeDir, cwd, id);
  const patch = await retained(candidate);
  const reviewToken = candidate.status === "ready" ? token(candidate, patch) : undefined;
  let rendered: string;
  try {
    rendered = utf8.decode(patch);
  } catch {
    rendered = `Patch contains invalid UTF-8; raw bytes rendered as hexadecimal:\n${patch.toString("hex")}`;
  }
  return { candidate, patch: rendered, reviewToken };
}
async function locked<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const filename = path.join(os.tmpdir(), `conduct-apply-${digest(root)}.lock`);
  const handle = await fs.open(filename, "wx", 0o600).catch(() => {
    throw new Error(
      `Another Conduct application may be running. If interrupted, inspect working files and remove ${filename} only after confirming no apply is active`,
    );
  });
  try {
    await handle.writeFile(String(process.pid));
    return await operation();
  } finally {
    await handle.close();
    await fs.unlink(filename);
  }
}
export async function applyCandidate(
  storeDir: string,
  cwd: string,
  id: string,
  reviewToken: string,
): Promise<CandidateRecord> {
  const root = await rootFor(cwd);
  return locked(root, async () => {
    const record = await load(storeDir, cwd, id);
    if (record.status !== "ready") throw new Error(`Candidate is ${record.status}, not applicable`);
    const patch = await retained(record);
    if (!reviewToken || token(record, patch) !== reviewToken)
      throw new Error("Review token is invalid; review the current candidate artifacts again");
    if (record.changes.some((file) => !record.files.includes(file)))
      throw new Error("Candidate delta exceeds its writable scope");
    try {
      for (const file of record.files) {
        if (JSON.stringify(await state(root, file)) !== JSON.stringify(record.baseline[file]))
          throw new Error(`Source changed since snapshot: ${file}`);
      }
    } catch (error) {
      record.status = "stale";
      record.error = message(error);
      await save(storeDir, record);
      return record;
    }
    const gitDir = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-apply-git-"));
    try {
      await git(gitDir, undefined, ["init", "--bare"]);
      await fs.writeFile(
        path.join(gitDir, "info", "attributes"),
        "* -text -filter -ident -working-tree-encoding\n",
      );
      if (patch.length) {
        const stats = (await git(gitDir, root, ["apply", "--numstat", "-z", "-"], patch))
          .split("\0")
          .filter(Boolean);
        const paths = stats.map((entry) => {
          const match = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]+)$/.exec(entry);
          if (!match) throw new Error("Invalid candidate patch path listing");
          return match[1]!;
        });
        if (
          JSON.stringify([...paths].sort()) !== JSON.stringify([...record.changes].sort()) ||
          paths.some((file) => !record.files.includes(file))
        )
          throw new Error("Candidate patch exceeds its recorded scope");
        await git(
          gitDir,
          root,
          ["apply", "--check", "--binary", "--whitespace=nowarn", "-"],
          patch,
        );
      }
      record.status = "applying";
      await save(storeDir, record);
      try {
        if (patch.length)
          await git(gitDir, root, ["apply", "--binary", "--whitespace=nowarn", "-"], patch);
        record.status = "applied";
      } catch (error) {
        record.status = "failed";
        record.error = `Application failed or was interrupted; working files may have been partially changed. Inspect them before continuing. ${message(error)}`;
      }
      await save(storeDir, record);
      return record;
    } finally {
      await fs.rm(gitDir, { recursive: true, force: true });
    }
  });
}
export async function rejectCandidate(
  storeDir: string,
  cwd: string,
  id: string,
): Promise<CandidateRecord> {
  const root = await rootFor(cwd);
  return locked(root, async () => {
    const record = await load(storeDir, cwd, id);
    if (record.status === "running" || record.status === "applying" || record.status === "applied")
      throw new Error(`Cannot reject a ${record.status} candidate`);
    record.status = "rejected";
    delete record.reviewToken;
    await save(storeDir, record);
    return record;
  });
}
export async function recoverCandidates(storeDir: string, cwd: string): Promise<void> {
  for (const record of await listCandidates(storeDir, cwd)) {
    if (record.status === "running" || record.status === "applying") {
      const interruptedApply = record.status === "applying";
      record.status = "failed";
      record.error = interruptedApply
        ? "Application interrupted; working files may be partially changed. Inspect them manually; this candidate cannot be reapplied."
        : "Worker interrupted by session restart; retained candidate is not applicable.";
      delete record.reviewToken;
      await save(storeDir, record);
      // An orphan snapshot is retained for manual recovery, never redispatched.
    }
  }
}
