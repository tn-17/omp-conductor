import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expandTilde } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { parseMarkers, type MarkerRegion } from "./markers";

const MAX_SOURCE_BYTES = 1024 * 1024;

export interface MarkerFile {
  path: string;
  realPath: string;
  digest: string;
  regions: MarkerRegion[];
}

export interface MarkerSelection extends MarkerRegion {
  id: string;
  path: string;
  realPath: string;
  digest: string;
}

async function readSource(
  filePath: string,
): Promise<{ realPath: string; bytes: ArrayBuffer; digest: string }> {
  const realPath = await fs.realpath(filePath);
  const file = Bun.file(realPath);
  const stat = await file.stat();
  if (!stat.isFile()) throw new Error(`Marker source must be a regular file: ${filePath}`);
  if (stat.size > MAX_SOURCE_BYTES) throw new Error(`Marker source exceeds 1 MiB: ${filePath}`);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_SOURCE_BYTES)
    throw new Error(`Marker source exceeds 1 MiB: ${filePath}`);
  return { realPath, bytes, digest: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
}

export async function readMarkerFile(cwd: string, filename: string): Promise<MarkerFile> {
  if (!filename.trim()) throw new Error("Specify a source filename.");
  const filePath = path.resolve(cwd, expandTilde(filename));
  const { realPath, bytes, digest } = await readSource(filePath);
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return { path: filePath, realPath, digest, regions: await parseMarkers(source, filePath) };
}

export function selectMarker(
  file: MarkerFile,
  selector: { marker?: string; line?: number } = {},
): MarkerSelection {
  if (selector.marker !== undefined && selector.line !== undefined) {
    throw new Error("Select by marker name OR start line, not both.");
  }
  if (selector.line !== undefined && (!Number.isSafeInteger(selector.line) || selector.line < 1)) {
    throw new Error("Marker line must be a positive integer.");
  }
  const candidates =
    selector.marker !== undefined
      ? file.regions.filter((region) => region.name === selector.marker)
      : selector.line !== undefined
        ? file.regions.filter((region) => region.startLine === selector.line)
        : file.regions;
  if (candidates.length === 0)
    throw new Error(
      `No matching OMP-CONDUCT directive in ${file.path}. List markers and choose an exact name or start line.`,
    );
  if (candidates.length > 1)
    throw new Error(
      `Multiple OMP-CONDUCT directives in ${file.path}. Choose an exact name or @startLine.`,
    );
  return {
    ...candidates[0],
    id: Bun.randomUUIDv7(),
    path: file.path,
    realPath: file.realPath,
    digest: file.digest,
  };
}

export async function verifySelection(selection: MarkerSelection): Promise<string> {
  let current: { realPath: string; digest: string };
  try {
    current = await readSource(selection.path);
  } catch (error) {
    throw new Error(
      `Selected source is no longer readable; reselect before dispatch: ${selection.path}`,
      { cause: error },
    );
  }
  if (current.realPath !== selection.realPath || current.digest !== selection.digest) {
    throw new Error(
      `Selected source changed; reselect and review the updated directive before dispatch: ${selection.path}`,
    );
  }
  return selection.directive;
}
