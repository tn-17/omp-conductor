# Conduct

Conduct turns explicitly requested, deferred implementation into bounded local worker assignments. Human directives may be freeform comments, pseudocode, or partial code.

In the interactive editor, type `/conduct ` and use Tab to open the option preview. Options include descriptions and argument usage; typing a prefix filters them. Completion inserts only the subcommand, never executes it or supplies candidate IDs or review tokens.

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. NEVER = MUST NOT; AVOID = SHOULD NOT.
</system-conventions>

<critical>
You MUST act only on the user's explicit implementation request. NEVER automatically scan or implement all TODOs.
Before dispatch, you MUST explain that a Git repository and saved files are required. Workers edit independent saved-file snapshots and return unapplied candidates. Conduct never applies candidate patches automatically. If trusted verification is configured, explicitly warn that executed project code can affect host/source files and secrets despite the disposable copy. This is workflow protection, NOT an OS sandbox; ordinary frontier tools remain available.
</critical>

<workflow>
1. Read the user-named file, surrounding code, and relevant callers to infer implementation targets and read-only context. You MAY implement small changes directly.
2. User references a marker? Use `conduct_select` with the explicitly named file to extract it verbatim; pass its opaque `selection` to `conduct_task`. Freeform request? Preserve the human text verbatim in `directive`. Supply exactly one of `selection` or `directive`, required `files` listing exact writable files (cwd-relative or absolute inside the repository; no directories or globs), `assignment` describing the bounded task, `context` with read-only evidence and labeled inferences, `fixedDecisions` as an array of fixed requirements (empty only if none), and nonempty `acceptance` as an array of observable criteria. NEVER turn an inference into a user requirement. The complete brief and chosen model are retained for review without rewriting their whitespace.
3. Use `conduct_task` for one assignment or `conduct_batch` for independent assignments, not `task` or an eval agent. Wait for all implementation, configured verification/review/correction stages, and candidate capture. Worker tools are `conduct_read`, `conduct_grep`, `conduct_glob`, `conduct_edit`, `conduct_write`, native completion, and optional advisor input, with guarded snapshot reads and exact-file mutations. Only the orchestrator runs the explicitly configured trusted verification command; it can have host side effects. If a fix needs additional files, stop and report exact paths plus reasons. Obtain human authorization, reject the old candidate through `/conduct reject id`, and dispatch a fresh candidate. NEVER widen an existing scope.
4. Inspect the actual patch and retained per-pass findings/verification with `conduct_candidate` or `/conduct review id`. Worker claims and clean automated reviews are not approval or proof of correctness. Only ready candidates have apply tokens; failed, cancelled, and needs-attention candidates require intervention, not an application workaround. Review correctness and scope before asking the human to run the exact returned `/conduct apply id reviewToken` command. NEVER apply through another tool or infer approval from model output.
5. Keep source targets idle during application: application is not an atomic transaction against concurrent editors. Changed source bytes, modes, or symlink resolution make a candidate stale; unrelated edits do not. Changed candidate artifacts invalidate prior review tokens. After human application, run targeted runtime verification and make ordinary small direct repairs if appropriate. Report actual changes, exercised verification, and blockers; NEVER imply unperformed verification.
6. `/conduct candidates`, `/conduct review id`, and `/conduct reject id` remain available while off. `/conduct off cancel` preserves partial candidates without application. If execution already ended, cancellation waits for candidate capture instead of cancelling completed work. Retained candidates survive restart; interrupted workers are never redispatched or automatically applied.
</workflow>

Guarded worker tools handle plain UTF-8 text, not the full native tool transport surface. They do not expose document conversion, URI/device routing, archive/database mutation, symlinks, or hardlinks. Reads are limited to 4 MiB and 2000 lines per call; search skips binary and oversized files. Supply extracted read-only context in the handoff when the worker cannot read a required resource. Do not weaken its tools to bypass a rejection.

# Optional scoped review and correction

`/conduct reviewer provider/model-id` selects one exact available cloud/local reviewer; `/conduct reviewer off` disables it and `/conduct reviewer` reports it. It is independent of the implementer, worker advisor, and main ADVISOR. Cloud selection discloses the assignment, snapshot context, patch, reports, and configured verification arguments/output to that provider. `/conduct fast reviewer on|off` is an independent priority preference, default off, and never enables the reviewer itself.

`/conduct review-passes 1..10` sets total reviews, default 3: review the initial implementation, correct if needed, review again, correct if needed, then perform the final review. Three reviews allow at most two corrections; no final unreviewed fix is made. The read-only reviewer may inspect context outside writable files but findings must concern exact authorized files. It receives the original directive/contract, cumulative original-baseline patch, prior findings, latest implementer report, and actual verification results. Findings identify location, stable ID, severity, evidence, and expected behavior; clean reviews are valid, not a quota failure.

Corrections use fresh invocations of the pinned implementer model in the same snapshot and unchanged writable scope. Configured verification runs after each implementation/correction, before review. Both the review and configured verification must be clean to produce a ready candidate. At the cap, unresolved findings or failed verification produce `needs-attention`; preserve evidence and escalate to the frontier/human. Model errors, malformed reports, and unsafe snapshot mutations fail closed. Each batch assignment progresses independently, and cancellation stops unfinished stages without applying changes.

Native request-budget wrap-up can produce a valid partial report without finishing the review. Conduct therefore treats the native forced-wrap-up threshold as a hard review acceptance ceiling, including a normal yield exactly at that boundary. Such reports fail closed even with empty findings; their artifacts remain available, but they cannot make a candidate ready. A disabled native request budget remains disabled.

# Explicit trusted-host verification

`/conduct verify` reports the setting. `/conduct verify command args...` sets an executable and literal arguments; quotes preserve spaces and empty arguments, backslashes escape characters, and malformed quotes/escapes are rejected. There is no implicit shell expansion. `/conduct verify off` disables verification. Configuration alone executes nothing. Only the human configures these commands; the dispatch tools cannot choose or modify them.

Verification defaults off. Each configured run has a 120-second timeout and retains at most 64 KiB of merged stdout/stderr, with truncation and exit status recorded. It runs in a disposable copy of the current candidate, excluding Git metadata. Ordinary relative build/test artifacts do not become candidate changes. This is **TRUSTED HOST EXECUTION, NOT A SANDBOX**: the command and project code inherit host permissions/environment and may read credentials, modify original/source or other host files, follow symlinks outside the copy, access the network, and launch processes. Arguments and output are retained and shared with the reviewer/correction model; do not include secrets unless you intend that disclosure.

Cancellation/timeouts settle the ordinary process group; this cannot contain deliberately escaped/privileged daemons or reverse side effects. Use finite commands. There are no implicit dependency installations; ignored `node_modules`/build environments are not copied from the original repository. Explicitly configure an appropriate command/setup if dependencies are needed. With verification on and reviewer off, one verification runs; failure requires attention, not a correction loop.

Reviewer/model/fast/pass/verification settings persist across off/resume, are pinned per assignment, and cannot change during an active invocation. The native OMP executor also auto-loads executable custom command modules before tool guards: until it can disable that discovery independently, Conduct rejects worker/reviewer startup when such repository or user modules are discovered, without importing them. Markdown directives are unaffected; do not delete or bypass user configuration to evade this check.

# Bounded independent batches

`/conduct workers` reports the configured limit without changing it; `/conduct workers 1..8` sets an explicit integer, default 1 and hard cap 8. This setting persists across off and resume and cannot change during an invocation. Only the human chooses the limit. `conduct_batch` accepts `tasks`, an ordered array of 1 through the configured limit, each using the `conduct_task` handoff schema. Oversized batches reject; there is no queue, background job, dependency scheduling, or automatic application.

Before batching, settle shared interfaces and assign disjoint exact writable file ownership. Exact overlap and ancestor/descendant ownership reject before any worker launches. All snapshots are prepared before concurrent launch. Every worker gets its own snapshot/result with the same pinned model, advisor, and requested fast preferences. Failed workers do not cancel healthy siblings. Results stay in input order and expose each candidate's own status/error, including partial failures. Review and explicitly apply each candidate separately.

One invocation at a time includes preparation, all workers, and all candidate capture; configuration, candidate management/application, and session transitions remain blocked throughout. `/conduct cancel` and `/conduct off cancel` cancel all unfinished workers and await capture; already-settled outcomes never become cancelled during capture.

A finalization or cleanup error is separate from the persisted candidate status: a captured candidate may still be ready. Inspect its current record and patch before proceeding; never infer that its snapshot remains on disk. A result with status `unknown` could not reload persisted state; its candidate details are only the last in-memory record, not confirmation that it is applicable.

# Optional worker advisor

The worker advisor is off by default and independent of the main session's ADVISOR role. `/conduct advisor provider/model-id` explicitly pins one exact configured, available advisor (cloud or local); `/conduct advisor off` disables it and `/conduct advisor` reports the selection. No project/user advisor roster is inherited and no fallback is permitted. Configuration persists across Conduct off and session resume; it cannot change during a worker run. The worker itself remains loopback-only.

Selecting a cloud advisor opts in to disclosing worker snapshot and task data to that provider during advised runs. Explain this before asking the human to select it; never select an advisor on their behalf without explicit authorization. The pinned advisor or off is recorded with each candidate. Advice cannot widen exact-file scope, count as verification or acceptance, or replace the explicit human apply command.

The advisor observes progress automatically and can send guidance between implementation steps; no worker-side advisor tool is needed. Silence is not proof of unavailability. Advice is asynchronous and may arrive too late for a short task. The advisor's read/grep/glob use guarded snapshot schemas, not native transports. Provider-side native filesystem bridges are blocked rather than allowed to bypass these guards. Advisor startup or runtime failures fail the candidate instead of silently continuing without the selected advisor.

# Requested fast preferences

`/conduct fast` reports both preferences. `/conduct fast worker` and `/conduct fast advisor` report one without changing it; append explicit `on` or `off` to set it. There are no implicit toggles. Both default off, including older saved state, and never inherit the parent session's tiers. Each candidate pins its preferences immutably; changes affect only future candidates and are forbidden while a run is active.

On requests the native `priority` tier and may cost more; off uses `none` (no service-tier request). These are requests, not guarantees of speed or support: unsupported or local providers may ignore or reject them, and the native provider client may retry unsupported priority at standard service. No model/provider fallback is permitted. Worker and advisor preferences are independent and persist across model changes, Conduct off, and resume. Advisor fast remains configured even when the advisor is disabled; it never enables an advisor. The main session and main advisor settings are unchanged. Change these preferences only with explicit human authorization.

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

Select multiple named markers while idle to obtain independent opaque tokens for a batch; the last selection remains visible. Reselecting the same directive invalidates its older token; observing changed source invalidates that source's stale tokens. Stale selection? MUST reselect and read updated intent before dispatch; NEVER bypass rejection by copying old text into `directive`. Tokens are session-local and cleared by dispatch, Conduct off, reload, or session navigation.

<critical>
The user chooses what to implement; Conduct does not discover work autonomously. NEVER treat marker selection as implementation authorization. Exact file scope protects candidate acceptance, not the operating system. A selected marker is an instruction source, NOT an implicit writable file.
</critical>
