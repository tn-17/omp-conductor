import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readMarkerFile, selectMarker, verifySelection } from "../selection";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "conduct-selection-"));
  directories.push(directory);
  return directory;
}

test("explicit names or start lines disambiguate without fuzzy selection", async () => {
  const cwd = await workspace();
  await Bun.write(
    path.join(cwd, "file with spaces.ts"),
    "// OMP-CONDUCT: first\n// OMP-CONDUCT BEGIN: second\n// Keep café\n// OMP-CONDUCT END: second\n",
  );
  const file = await readMarkerFile(cwd, "file with spaces.ts");
  expect(() => selectMarker(file)).toThrow("Multiple");
  expect(() => selectMarker(file, { marker: "sec" })).toThrow("No matching");
  expect(() => selectMarker(file, { line: 3 })).toThrow("No matching");
  expect(() => selectMarker(file, { line: 1, marker: "second" })).toThrow("not both");
  expect(selectMarker(file, { line: 1 }).directive).toBe("// OMP-CONDUCT: first");
  expect(selectMarker(file, { marker: "second" }).directive).toBe(
    "// OMP-CONDUCT BEGIN: second\n// Keep café\n// OMP-CONDUCT END: second",
  );
});

test("any source change invalidates the snapshot but changes to other files do not", async () => {
  const cwd = await workspace();
  const filename = path.join(cwd, "source.py");
  await Bun.write(filename, "# OMP-CONDUCT: implement\npass\n");
  const selection = selectMarker(await readMarkerFile(cwd, filename));
  await Bun.write(path.join(cwd, "other.py"), "pass\n");
  expect(await verifySelection(selection)).toBe("# OMP-CONDUCT: implement");
  await Bun.write(filename, "# OMP-CONDUCT: implement\nnew_code()\n");
  await expect(verifySelection(selection)).rejects.toThrow("source changed");
});

test("symlink retargeting invalidates even an identical source snapshot", async () => {
  const cwd = await workspace();
  const text = "// OMP-CONDUCT: implement\n";
  await Bun.write(path.join(cwd, "first.ts"), text);
  await Bun.write(path.join(cwd, "second.ts"), text);
  const link = path.join(cwd, "selected.ts");
  await fs.symlink("first.ts", link);
  const selection = selectMarker(await readMarkerFile(cwd, "selected.ts"));
  await fs.unlink(link);
  await fs.symlink("second.ts", link);
  await expect(verifySelection(selection)).rejects.toThrow("source changed");
});

test("missing selected files fail closed instead of supplying cached directives", async () => {
  const cwd = await workspace();
  const filename = path.join(cwd, "source.ts");
  await Bun.write(filename, "// OMP-CONDUCT: implement\n");
  const selection = selectMarker(await readMarkerFile(cwd, filename));
  await fs.unlink(filename);
  await expect(verifySelection(selection)).rejects.toThrow("no longer readable");
});

test("non-file and oversized inputs are refused before marker processing", async () => {
  const cwd = await workspace();
  await fs.mkdir(path.join(cwd, "directory.ts"));
  await expect(readMarkerFile(cwd, "directory.ts")).rejects.toThrow("regular file");
  await Bun.write(path.join(cwd, "large.ts"), new Uint8Array(1024 * 1024 + 1));
  await expect(readMarkerFile(cwd, "large.ts")).rejects.toThrow("1 MiB");
});
