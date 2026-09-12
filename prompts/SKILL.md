# Conduct

Conduct turns explicitly requested, deferred implementation into bounded local worker assignments. Human directives may be freeform comments, pseudocode, or partial code.

In the interactive editor, type `/conductor ` and use Tab to open the option preview. Options include descriptions and argument usage; typing a prefix filters them. Completion inserts only the subcommand, never executes it or supplies candidate IDs or review tokens.

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. NEVER = MUST NOT; AVOID = SHOULD NOT.
</system-conventions>

<critical>
The enabled system prompt includes the canonical `conduct_task` handoff below; it is the source of truth for dispatch fields and shared safety rules and also governs every `conduct_batch.tasks` item. It requires explicit user authorization, a saved Git repository, exact writable files, and exactly one selection or directive. NEVER automatically scan or implement all TODOs.
Before dispatch, explain the saved-repository/snapshot workflow and, when trusted verification is configured, warn that executed project code can affect host/source files and secrets despite the disposable copy. This is workflow protection, NOT an OS sandbox; ordinary frontier tools remain available.
</critical>

<workflow>
1. Read the user-named file, surrounding code, and relevant callers to infer implementation targets and read-only context. You MAY implement small changes directly.
2. Follow the canonical `conduct_task` handoff in the enabled system prompt for the dispatch schema, exact-file scope, authorization, and selection/directive rules; it also governs each `conduct_batch.tasks` item. Use `conduct_select` for marker tokens and reselect after stale-source rejection. NEVER treat selection or preview as implementation authorization.
3. Use `conduct_task` for one assignment or `conduct_batch` for independent assignments, not `task` or an eval agent. Wait for all implementation, configured verification/review/correction stages, and candidate capture. If a fix needs additional files, stop and report the exact additional paths and reasons. Obtain fresh human authorization before changing scope; if authorization is declined, leave the existing candidate retained and do not reject it. Only after authorization, reject the old candidate through `/conductor reject id`, then dispatch with the new scope. NEVER widen an existing scope.
4. Inspect the actual patch and retained per-pass findings/verification with `conduct_candidate` or `/conductor review id`. Worker claims and clean automated reviews are not approval or proof of correctness. Only ready candidates have apply tokens; failed, cancelled, and needs-attention candidates require intervention, not an application workaround. Review correctness and scope before asking the human to run the exact returned `/conductor apply id reviewToken` command. NEVER apply through another tool or infer approval from model output.
5. Keep source targets idle during application: application is not an atomic transaction against concurrent editors. Changed source bytes, modes, or symlink resolution make a candidate stale; unrelated edits do not. Changed candidate artifacts invalidate prior review tokens. After human application, run targeted runtime verification and make ordinary small direct repairs if appropriate. Report actual changes, exercised verification, and blockers; NEVER imply unperformed verification.
6. `/conductor candidates`, `/conductor review id`, and `/conductor reject id` remain available while off. `/conductor off cancel` preserves partial candidates without application. If execution already ended, cancellation waits for candidate capture instead of cancelling completed work. Retained candidates survive restart; interrupted workers are never redispatched or automatically applied.
</workflow>

Guarded worker tools handle plain UTF-8 text, not the full native tool transport surface. They do not expose document conversion, URI/device routing, archive/database mutation, symlinks, or hardlinks. Reads are limited to 4 MiB and 2000 lines per call; search skips binary and oversized files. Supply extracted read-only context in the handoff when the worker cannot read a required resource. Do not weaken its tools to bypass a rejection.

# Optional scoped review and correction

The canonical task handoff covers human-only reviewer/verification selection and the no-fallback/no-bypass rules. `/conductor reviewer provider/model-id` selects one exact available cloud/local reviewer; `/conductor reviewer off` disables it and `/conductor reviewer` reports it. It is independent of the implementer, worker advisor, and main ADVISOR. Cloud selection discloses the assignment, snapshot context, patch, reports, and configured verification arguments/output to that provider. `/conductor fast reviewer on|off` is an independent priority preference, default off, and never enables the reviewer itself.

`/conductor review-passes 1..10` sets total reviews, default 3: review the initial implementation, correct if needed, review again, correct if needed, then perform the final review. Three reviews allow at most two corrections; no final unreviewed fix is made. The read-only reviewer may inspect context outside writable files but findings must concern exact authorized files. It receives the original directive/contract, cumulative original-baseline patch, prior findings, latest implementer report, and actual verification results. Findings identify location, stable ID, severity, evidence, and expected behavior; clean reviews are valid, not a quota failure.

Corrections use fresh invocations of the pinned implementer model in the same snapshot and unchanged writable scope. Configured verification runs after each implementation/correction, before review. Both the review and configured verification must be clean to produce a ready candidate. At the cap, unresolved findings or failed verification produce `needs-attention`; preserve evidence and escalate to the frontier/human. Model errors, malformed reports, and unsafe snapshot mutations fail closed. Each batch assignment progresses independently, and cancellation stops unfinished stages without applying changes.

Native request-budget wrap-up can produce a valid partial report without finishing the review. Conduct therefore treats the native forced-wrap-up threshold as a hard review acceptance ceiling, including a normal yield exactly at that boundary. Such reports fail closed even with empty findings; their artifacts remain available, but they cannot make a candidate ready. A disabled native request budget remains disabled.

# Explicit trusted-host verification

`/conductor verify` reports the setting. `/conductor verify command args...` sets an executable and literal arguments; quotes preserve spaces and empty arguments, backslashes escape characters, and malformed quotes or escapes are rejected. There is no implicit shell expansion. `/conductor verify off` disables verification. Configuration alone executes nothing. Only the human configures these commands; the dispatch tools cannot choose or modify them.

Verification defaults off. Each configured run has a 120-second timeout and retains at most 64 KiB of merged stdout/stderr, with truncation and exit status recorded. It runs in a disposable copy of the current candidate, excluding Git metadata. Ordinary relative build/test artifacts do not become candidate changes. This is **TRUSTED HOST EXECUTION, NOT A SANDBOX**: the command and project code inherit host permissions/environment and may read credentials, modify original/source or other host files, follow symlinks outside the copy, access the network, and launch processes. Arguments and output are retained and shared with the reviewer/correction model; do not include secrets unless you intend that disclosure.

Cancellation/timeouts settle the ordinary process group; this cannot contain deliberately escaped/privileged daemons or reverse side effects. Use finite commands. There are no implicit dependency installations; ignored `node_modules`/build environments are not copied from the original repository. Explicitly configure an appropriate command/setup if dependencies are needed. With verification on and reviewer off, one verification runs; failure requires attention, not a correction loop.

Reviewer/model/fast/pass/verification settings persist across off/resume, are pinned per assignment, and cannot change during an active invocation. The native OMP executor also auto-loads executable custom command modules before tool guards: until it can disable that discovery independently, Conduct rejects worker/reviewer startup when such repository or user modules are discovered, without importing them. Markdown directives are unaffected; do not delete or bypass user configuration to evade this check.

# Bounded independent batches

The canonical task handoff defines `conduct_batch`'s human-configured limit, independent exact ownership, snapshot preparation, ordered results, sibling behavior, no queue/dependencies/application, and cancellation. Use batches only after shared interfaces and disjoint ownership are settled; exact overlap and ancestor/descendant ownership remain rejected before launch.

One invocation at a time includes preparation, all workers, and all candidate capture; configuration, candidate management/application, and session transitions remain blocked throughout.

A finalization or cleanup error is separate from the persisted candidate status: a captured candidate may still be ready. Inspect its current record and patch before proceeding; never infer that its snapshot remains on disk. A result with status `unknown` could not reload persisted state; its candidate details are only the last in-memory record, not confirmation that it is applicable.

# Optional worker advisor

The canonical task handoff covers human-only advisor selection, exact model pinning, disclosure, and no-fallback rules. The advisor is independent of the main session's ADVISOR role; configuration persists across Conduct off and session resume, cannot change during a worker run, and the worker itself remains loopback-only.

Selecting a cloud advisor opts in to disclosing worker snapshot and task data to that provider during advised runs. Explain this before asking the human to select it; never select an advisor on their behalf without explicit authorization. The pinned advisor or off is recorded with each candidate. Advice cannot widen exact-file scope, count as verification or acceptance, or replace the explicit human apply command.

The advisor observes progress automatically and can send guidance between implementation steps; no worker-side advisor tool is needed. Silence is not proof of unavailability. Advice is asynchronous and may arrive too late for a short task. The advisor's read/grep/glob use guarded snapshot schemas, not native transports. Provider-side native filesystem bridges are blocked rather than allowed to bypass these guards. Advisor startup or runtime failures fail the candidate instead of silently continuing without the selected advisor.

# Requested fast preferences

`/conductor fast` reports the independent worker, advisor, and reviewer preferences. `/conductor fast worker|advisor|reviewer` reports one without changing it; append explicit `on` or `off` to set it. There are no implicit toggles. All three default off, including older saved state, and never inherit the parent session's tiers. Each candidate pins its preferences immutably; changes affect only future candidates and are forbidden while a run is active.

On requests the native `priority` tier and may cost more; off uses `none` (no service-tier request). These are requests, not guarantees of speed or support: unsupported or local providers may ignore or reject them, and the native provider client may retry unsupported priority at standard service. No model/provider fallback is permitted. Worker, advisor, and reviewer preferences are independent and persist across model changes, Conduct off, and resume. Advisor fast remains configured even when the advisor is disabled and reviewer fast never enables its reviewer. The main session and main advisor settings are unchanged. Change these preferences only with explicit human authorization.

# Marker selection

`/conductor markers "file"` lists markers; `/conductor select "file" [name|@line]` previews one. Omit the selector only for a file with exactly one marker. `conduct_select` provides the same read-only lookup: path alone lists multiple markers or selects the only marker; choose explicitly by `marker` name or `line`, never both. Selection and preview do not dispatch or authorize implementation.

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
