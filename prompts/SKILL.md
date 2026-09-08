# Conduct

Conduct turns explicitly requested, deferred implementation into one local worker assignment. Human directives may be freeform comments, pseudocode, or partial code.

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. NEVER = MUST NOT; AVOID = SHOULD NOT.
</system-conventions>

<critical>
You MUST act only on the user's explicit implementation request. NEVER automatically scan or implement all TODOs.
Before dispatch, you MUST explain that a Git repository and saved files are required. Workers edit independent saved-file snapshots and return protected unapplied candidates. This is workflow protection, NOT an OS sandbox; ordinary frontier tools remain available.
</critical>

<workflow>
1. Read the user-named file, surrounding code, and relevant callers to infer implementation targets and read-only context. You MAY implement small changes directly.
2. User references a marker? Use `conduct_select` with the explicitly named file to extract it verbatim; pass its opaque `selection` to `conduct_task`. Freeform request? Preserve the human text verbatim in `directive`. Supply exactly one of `selection` or `directive`, required `files` listing exact writable files (cwd-relative or absolute inside the repository; no directories or globs), plus `assignment`: target paths/symbols, read-only context, observable acceptance criteria, and fixed requirements separated from inferred choices. NEVER turn an inference into a user requirement.
3. Use `conduct_task`, not `task` or an eval agent. Dispatch one local worker; wait for its synchronous completion. Source targets are not automatically changed, including on failure or cancellation.
4. Inspect the actual patch with `conduct_candidate` or `/conduct review id`; a worker report is never verification evidence. Review correctness and scope before asking the human to run the exact returned `/conduct apply id reviewToken` command. NEVER apply through tools or infer approval from worker output. Only that explicit human command applies the reviewed content.
5. Keep source targets idle during application: application is not an atomic transaction against concurrent editors. Changed source bytes, modes, or symlink resolution make a candidate stale; unrelated edits do not. Changed candidate artifacts invalidate prior review tokens. After human application, run targeted runtime verification and make ordinary small direct repairs if appropriate. Report actual changes, exercised verification, and blockers; NEVER imply unperformed verification.
6. `/conduct candidates`, `/conduct review id`, and `/conduct reject id` remain available while off. `/conduct off cancel` preserves partial candidates without application. If execution already ended, cancellation waits for candidate capture instead of cancelling completed work. Retained candidates survive restart; interrupted workers are never redispatched or automatically applied.
</workflow>

# Marker selection

`/conduct markers "file"` lists markers; `/conduct select "file" [name|@line]` previews one. Omit the selector only for a file with exactly one marker. `conduct_select` provides the same read-only lookup: path alone lists multiple markers or selects the only marker; choose explicitly by `marker` name or `line`, never both. Selection and preview do not dispatch or authorize implementation.

Markers are standalone language-native `//` or `#` comments with uppercase `OMP-CONDUCT`; strings, prose, and trailing inline comments are not markers. Single markers use their starting line; named pairs use matching case-sensitive names from `[A-Za-z0-9][A-Za-z0-9_.-]*`.

```ts
// OMP-CONDUCT: Return cached results when available.

// OMP-CONDUCT BEGIN: cache-results
// Return cached results when available.
// OMP-CONDUCT END: cache-results
```

Supported sources: TS/JS (including TSX/JSX and module variants), Python, Rust, Go, Java, C/C++, C#, and Dart. Use `#` in Python; `//` in the others. Unsupported extensions fail rather than falling back to text matching. Directives MUST be nonempty; names MUST be unique; pairs MUST match and MUST NOT nest. Selected text includes marker lines and original whitespace. Markers delimit instructions, not writable code boundaries; infer affected code from the directive and actual context.

Stale selection? MUST reselect and read updated intent before dispatch; NEVER bypass rejection by copying old text into `directive`. Tokens are session-local and cleared by Conduct off, reload, or session navigation.

<critical>
The user chooses what to implement; Conduct does not discover work autonomously. NEVER treat marker selection as implementation authorization. Exact file scope protects candidate acceptance, not the operating system. A selected marker is an instruction source, NOT an implicit writable file.
</critical>
