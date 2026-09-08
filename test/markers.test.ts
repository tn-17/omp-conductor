import { expect, test } from "bun:test";
import { parseMarkers } from "../markers";

test("standalone comments exclude strings, templates, block comments and trailing comments", async () => {
  const source = [
    'const quoted = "// OMP-CONDUCT: quoted";',
    "const template = `",
    "// OMP-CONDUCT: template",
    "`;",
    "/*",
    "// OMP-CONDUCT BEGIN: false-block",
    "*/",
    "const value = 1; // OMP-CONDUCT: trailing",
    "// omp-conduct: lowercase",
    "// OMP-CONDUCTOR: unrelated",
    "// OMP-CONDUCT: real",
  ].join("\n");
  expect(await parseMarkers(source, "source.ts")).toEqual([
    { startLine: 11, endLine: 11, directive: "// OMP-CONDUCT: real" },
  ]);
});

test("Python triple and raw strings do not introduce markers", async () => {
  const source = [
    'text = """',
    "# OMP-CONDUCT END: fake",
    '"""',
    "raw = r'''",
    "# OMP-CONDUCT: fake",
    "'''",
    "value = 1 # OMP-CONDUCT: trailing",
    "# OMP-CONDUCT: real",
  ].join("\n");
  expect(await parseMarkers(source, "source.pyw")).toEqual([
    { startLine: 8, endLine: 8, directive: "# OMP-CONDUCT: real" },
  ]);
});

test("Rust raw strings and nested block comments cannot masquerade as directives", async () => {
  const source = [
    'const RAW: &str = r##"',
    "// OMP-CONDUCT: raw",
    '"##;',
    "/* outer /* nested */",
    "// OMP-CONDUCT: block",
    "*/",
    "// OMP-CONDUCT: real",
  ].join("\n");
  expect(await parseMarkers(source, "source.rs")).toEqual([
    { startLine: 7, endLine: 7, directive: "// OMP-CONDUCT: real" },
  ]);
});

test("named spans preserve Unicode, indentation and internal CRLF without the final terminator", async () => {
  const directive =
    "\t// OMP-CONDUCT BEGIN: repair.2-x\r\n  // Fix café → 東京\r\n  run();\r\n\t// OMP-CONDUCT END: repair.2-x";
  const source = `const before = "😀";\r\n${directive}\r\nconst after = 1;\r\n`;
  expect(await parseMarkers(source, "source.ts")).toEqual([
    { name: "repair.2-x", startLine: 2, endLine: 5, directive },
  ]);
});

test("BOM and Unicode whitespace align native columns while preserving source", async () => {
  const directive = "\uFEFF\u2003// OMP-CONDUCT: café";
  expect(await parseMarkers(`${directive}\r\n`, "source.ts")).toEqual([
    { startLine: 1, endLine: 1, directive },
  ]);
});

test("identical unnamed directives remain independently selectable by line", async () => {
  expect(await parseMarkers("  // OMP-CONDUCT: fix\n\n  // OMP-CONDUCT: fix", "source.js")).toEqual(
    [
      { startLine: 1, endLine: 1, directive: "  // OMP-CONDUCT: fix" },
      { startLine: 3, endLine: 3, directive: "  // OMP-CONDUCT: fix" },
    ],
  );
});

test("names are case sensitive and adjacent blocks stay separate", async () => {
  const first = "// OMP-CONDUCT BEGIN: A\n// First\n// OMP-CONDUCT END: A";
  const second = "// OMP-CONDUCT BEGIN: a\n// Second\n// OMP-CONDUCT END: a";
  expect(await parseMarkers(`${first}\n${second}`, "source.go")).toEqual([
    { name: "A", startLine: 1, endLine: 3, directive: first },
    { name: "a", startLine: 4, endLine: 6, directive: second },
  ]);
});

test("incomplete syntax retains genuine comments rather than rejecting the file", async () => {
  expect(await parseMarkers("// OMP-CONDUCT: finish\nfunction unfinished( {", "source.ts")).toEqual(
    [{ startLine: 1, endLine: 1, directive: "// OMP-CONDUCT: finish" }],
  );
  expect(await parseMarkers("# OMP-CONDUCT: finish\ndef unfinished(", "source.py")).toEqual([
    { startLine: 1, endLine: 1, directive: "# OMP-CONDUCT: finish" },
  ]);
});

test.each([
  ["// OMP-CONDUCT BEGIN: invalid name", 1],
  ["// OMP-CONDUCT: \t", 1],
  ["// OMP-CONDUCT END: absent", 1],
  ["// OMP-CONDUCT BEGIN: absent\n// Work", 1],
  ["// OMP-CONDUCT BEGIN: A\n// Work\n// OMP-CONDUCT END: a", 3],
  ["// OMP-CONDUCT BEGIN: outer\n// OMP-CONDUCT BEGIN: inner", 2],
  ["// OMP-CONDUCT BEGIN: outer\n// OMP-CONDUCT: single", 2],
  ["// OMP-CONDUCT BEGIN: empty\n \t\n//\n// OMP-CONDUCT END: empty", 1],
  [
    "// OMP-CONDUCT BEGIN: twice\n// Work\n// OMP-CONDUCT END: twice\n// OMP-CONDUCT BEGIN: twice",
    4,
  ],
])("invalid marker structure reports source location: %s", async (source, line) => {
  await expect(parseMarkers(source, "broken.ts")).rejects.toThrow(`broken.ts:${line}:`);
});

test("unsupported sources never silently parse comment-like prose", async () => {
  await expect(parseMarkers("// OMP-CONDUCT: prose", "notes.md")).rejects.toThrow("notes.md");
  await expect(parseMarkers("", "no-extension")).rejects.toThrow("no-extension");
});

test.each(["tsx", "jsx", "java", "c", "h", "cs", "dart"])(
  "%s grammar recognizes real comments but excludes block-comment lookalikes",
  async (extension) => {
    const source = "/*\n// OMP-CONDUCT: fake\n*/\n// OMP-CONDUCT: real  ";
    expect(await parseMarkers(source, `source.${extension}`)).toEqual([
      { startLine: 4, endLine: 4, directive: "// OMP-CONDUCT: real  " },
    ]);
  },
);
