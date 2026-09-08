import * as path from "node:path";
import { astMatch, AstMatchStrictness } from "@oh-my-pi/pi-natives";

export interface MarkerRegion {
  name?: string;
  startLine: number;
  endLine: number;
  directive: string;
}

const languages: Readonly<Record<string, string>> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  py: "python",
  pyw: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cxx: "cpp",
  cs: "csharp",
  dart: "dart",
};
const matchLimit = 100_000;

interface Candidate {
  line: number;
  column: number;
  start: number;
  end: number;
  comment: string;
  marker: string;
}

export async function parseMarkers(source: string, filename: string): Promise<MarkerRegion[]> {
  const language = languages[path.extname(filename).slice(1).toLowerCase()];
  if (!language) throw new Error(`${filename}: unsupported marker source extension`);
  const prefix = language === "python" ? "#" : "//";
  const candidatePattern =
    language === "python"
      ? /^(\s*)#[ \t]*(OMP-CONDUCT\b.*)$/
      : /^(\s*)\/\/[ \t]*(OMP-CONDUCT\b.*)$/;
  const candidates: Candidate[] = [];
  let start = 0;
  let line = 1;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const next = newline === -1 ? source.length : newline;
    const end = next > start && source[next - 1] === "\r" ? next - 1 : next;
    const text = source.slice(start, end);
    const match = candidatePattern.exec(text);
    if (match) {
      const indentation = match[1]!;
      candidates.push({
        line,
        column: indentation.length + 1,
        start,
        end,
        comment: text.slice(indentation.length),
        marker: match[2]!,
      });
    }
    start = next + 1;
    line++;
  }
  if (candidates.length === 0) return [];
  function fail(at: number, reason: string): never {
    throw new Error(`${filename}:${at}: ${reason}`);
  }
  const result = await astMatch({
    source,
    lang: language,
    // Context keeps trailing comment whitespace from being trimmed by pattern compilation.
    patterns: [...new Set(candidates.map((candidate) => `${candidate.comment}\n0`))],
    selector: language === "rust" || language === "java" ? "line_comment" : "comment",
    strictness: AstMatchStrictness.Cst,
    limit: matchLimit,
    timeoutMs: 5000,
  }).catch((error: unknown) => fail(candidates[0]!.line, `cannot parse markers: ${String(error)}`));
  if (result.limitReached || result.totalMatches > result.matches.length) {
    fail(candidates[0]!.line, "marker syntax query was truncated");
  }
  const patternErrors = result.parseErrors?.filter(
    (error) => error !== "parse error (syntax tree contains error nodes)",
  );
  if (patternErrors?.length)
    fail(candidates[0]!.line, `cannot parse markers: ${patternErrors.join("; ")}`);
  const positions = new Set(
    result.matches.map((match) => `${match.startLine}:${match.startColumn}`),
  );
  const regions: MarkerRegion[] = [];
  const names = new Set<string>();
  let open: { candidate: Candidate; name: string } | undefined;
  for (const candidate of candidates) {
    if (!positions.has(`${candidate.line}:${candidate.column}`)) continue;
    const single = /^OMP-CONDUCT:[ \t]*(.*)$/.exec(candidate.marker);
    if (single) {
      if (open) fail(candidate.line, `single marker inside block ${open.name}`);
      if (!single[1]!.trim()) fail(candidate.line, "empty directive");
      regions.push({
        startLine: candidate.line,
        endLine: candidate.line,
        directive: source.slice(candidate.start, candidate.end),
      });
      continue;
    }
    const paired = /^OMP-CONDUCT (BEGIN|END):[ \t]*([A-Za-z0-9][A-Za-z0-9_.-]*)[ \t]*$/.exec(
      candidate.marker,
    );
    if (!paired) fail(candidate.line, "malformed OMP-CONDUCT marker");
    const name = paired[2]!;
    if (paired[1] === "BEGIN") {
      if (open) fail(candidate.line, `nested block inside ${open.name}`);
      if (names.has(name)) fail(candidate.line, `duplicate marker name ${name}`);
      names.add(name);
      open = { candidate, name };
      continue;
    }
    if (!open) fail(candidate.line, `unmatched END ${name}`);
    if (open.name !== name) fail(candidate.line, `END ${name} does not match BEGIN ${open.name}`);
    const body = source.slice(open.candidate.end, candidate.start);
    const hasContent = body.split(/\r?\n/).some((text) => {
      const trimmed = text.trim();
      return (
        (trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed).length > 0
      );
    });
    if (!hasContent) fail(open.candidate.line, `empty directive in block ${name}`);
    regions.push({
      name,
      startLine: open.candidate.line,
      endLine: candidate.line,
      directive: source.slice(open.candidate.start, candidate.end),
    });
    open = undefined;
  }
  if (open) fail(open.candidate.line, `missing END for ${open.name}`);
  return regions;
}
