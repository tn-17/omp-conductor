# OMP Conductor

A human-directed implementation workflow for [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi): plan with a frontier model, leave directives or pseudocode in your code, and delegate bounded implementation to local models.

Conductor adds `/conduct` mode without modifying OMP itself. Implementers work in independent snapshots and return **unapplied candidates**. Optional verification and scoped adversarial review can drive corrections before the frontier reviews the final patch and you explicitly apply it.

**This is workflow protection, not an operating-system sandbox.** In particular, optional trusted verification executes project code with host permissions.

## Workflow

1. Discuss the design and constraints with your main frontier model.
2. Write the parts you want to control directly. Leave comments, pseudocode, or partial implementations for deferred work.
3. Ask the frontier to use Conduct for specific files or directives. It prepares the context, fixed decisions, acceptance criteria, and exact writable files.
4. Local implementers work in copied snapshots. Independent assignments can run concurrently.
5. If configured, Conduct runs verification and a scoped reviewer, then gives findings back to a fresh implementer for correction.
6. The frontier inspects the actual candidate patch and retained evidence.
7. You apply an acceptable candidate with its exact `/conduct apply` command, then verify the applied behavior.

Conductor does not automatically discover work, implement every TODO, widen file ownership, or apply model-generated patches. A model's completion report is not acceptance.

## Requirements

- Bun **1.3.14 or newer** and an installed `omp` CLI.
- Compatible OMP SDK packages. The current peer dependency minimum is **18.1.14**; see [package.json](./package.json).
- Git and a target project in a Git repository. Save your source files before dispatch; uncommitted saved work is supported.
- A worker model configured in OMP with an exact `provider/model-id` selector and an HTTP(S) **loopback endpoint**: `localhost`, `127.x.x.x`, or `::1`. Remote LAN and cloud endpoints are not accepted for implementers.
- Optional advisors and reviewers may use explicitly selected cloud or local models.
- Trusted verification currently requires a POSIX host; it is not supported on Windows.

Conductor is under active development and depends on OMP's SDK behavior. It is not a security sandbox or a general-purpose autonomous agent runner.

## Setup

Clone the extension and install its dependencies:

```sh
git clone https://github.com/tn-17/omp-conductor.git
cd omp-conductor
bun install
```

The OMP peer packages must resolve to compatible versions. If you develop against an OMP checkout, ensure those workspace packages are available to this extension.

From the **project you want to work on**, start a fresh OMP session with the extension's absolute path:

```sh
omp -e /absolute/path/to/omp-conductor
```

This loads Conductor for that invocation; it does not permanently install it. Keep your preferred frontier model as the main model, and select a separately configured local implementer:

```text
/conduct model <local-provider/model-id>
/conduct on
```

Replace angle-bracket placeholders with actual values. Conductor does not start an inference server or configure a model endpoint for you.

Type `/conduct ` and press **Tab** for option previews, descriptions, and argument usage. Typing a prefix filters the options. Completion inserts text; it does not execute commands or supply candidate IDs or review tokens.

## First assignment

Ordinary comments and freeform requests are valid inputs. Markers provide an explicit way to select a deferred directive:

```ts
// OMP-CONDUCT BEGIN: normalize-tags
// Trim each tag, discard empty strings, and deduplicate case-sensitively.
// Preserve first-occurrence order. Do not mutate the input array.
// OMP-CONDUCT END: normalize-tags
export function normalizeTags(tags: readonly string[]): string[] {
  throw new Error("Deferred implementation");
}
```

Save this in a file such as `src/tags.ts`, then ask the frontier:

> Use Conduct to implement the normalize-tags directive in src/tags.ts. Only src/tags.ts may change. Review the candidate and stop before application.

You can also inspect markers yourself:

```text
/conduct markers "src/tags.ts"
/conduct select "src/tags.ts" normalize-tags
```

**Selection is only a preview, not authorization to implement.** Markers delimit the directive, not the writable code region. The assignment's exact file list controls which files the implementer may edit; a marker source is not implicitly writable.

When the frontier has reviewed the actual candidate, use the exact command it returns:

```text
/conduct apply <candidate-id> <review-token>
```

Do not reuse an old token after the candidate artifacts change. Keep target files idle during application; it is not an atomic transaction against concurrent editors. Changed target bytes, file modes, or symlink resolution can make a candidate stale. Unrelated source edits do not automatically invalidate it.

## Optional scoped review and correction

Select the reviewer independently of the implementer and the main session's advisor:

```text
/conduct reviewer <provider/model-id>
/conduct review-passes 3
/conduct fast reviewer on
```

The reviewer is read-only. It receives the original directive and assignment, fixed decisions, acceptance criteria, cumulative patch against the original snapshot, previous findings, the latest implementer report, and available verification results. It may read surrounding snapshot context, but findings must concern the authorized writable files.

The default limit is **three total reviews**, not three corrections:

```text
Implementation → verification, if configured → review 1
    Findings or failed verification → correction → verification → review 2
    Remaining issues               → correction → verification → review 3
    Still unresolved               → needs-attention
```

Three reviews allow at most **two correction attempts**. The total review limit is configurable from **1 to 10**. Corrections use fresh invocations of the configured implementer model, in the same candidate snapshot and with unchanged writable scope. There is no final unreviewed correction.

A candidate becomes ready only when the configured review has no findings and configured verification passes. Exhausting the pass limit with unresolved issues produces `needs-attention`, not approval. Reviewer errors, invalid reports, and unsafe snapshot mutations fail closed.

Native request-budget wrap-up can return a valid partial report. Conductor treats that forced-wrap-up threshold as a hard review acceptance ceiling, including a normal yield exactly at the boundary. Budget-limited reports retain their artifacts but cannot make a candidate ready.

A clean automated review is neither proof of correctness nor permission to apply. The frontier and human acceptance steps remain necessary.

## Optional trusted verification

Only a human-configured command is used; implementers and reviewers do not receive shell tools.

```text
/conduct verify bun test
/conduct verify
/conduct verify off
```

`bun test` is an example, not an automatically selected command. Configure a finite command appropriate for your project and available dependencies. Configuration alone executes nothing.

Arguments are passed literally, without implicit shell expansion. Quotes preserve spaces and empty arguments; malformed quotes or trailing escapes are rejected. Explicitly choosing a shell as the executable is still trusted host execution.

Each verification run:

- Executes in a disposable copy of the current candidate, excluding Git metadata.
- Has a **120-second timeout**.
- Retains up to **64 KiB of merged stdout/stderr**, with exit status and truncation information.
- Keeps ordinary relative build/test artifacts out of the candidate patch.
- Performs cleanup of ordinary process-group descendants on completion, timeout, or cancellation.

**The disposable copy is not a sandbox.** The command and project code inherit host permissions and environment. They can read credentials, modify original/source or other host files, follow symlinks outside the copy, access the network, and start processes. Cancellation cannot reverse side effects or contain deliberately escaped or privileged daemons.

**Arguments and output are retained and shared with the configured reviewer and correction model.** Do not include secrets unless you intend that disclosure.

There are no implicit dependency installations. Ignored `node_modules` directories and other ignored build environments are not copied from the original repository. If necessary, explicitly configure an appropriate setup/test command; a command that worked in the original checkout may fail in the verification copy without those dependencies.

With verification enabled but the reviewer disabled, Conduct runs one verification step. A failure requires attention; it does not start a correction loop. Sandboxed execution is deferred.

## Optional in-flight advisor

The advisor supplies guidance while an implementer works; the reviewer inspects completed work afterward. They are separate, optional mechanisms:

```text
/conduct advisor <provider/model-id>
/conduct advisor off
```

The worker advisor defaults off and is independent of the main session's `ADVISOR` role. It receives guarded snapshot reads and an advice channel, not editing, execution, delegation, or application authority. Advice is asynchronous and may arrive too late for a short implementation. Advisor startup and runtime errors fail the candidate rather than silently continuing without the selected advisor.

Choosing a cloud advisor or reviewer discloses the relevant assignment, snapshot context, and evidence to that provider. Neither role can widen scope or approve application.

## Independent fast preferences

```text
/conduct fast worker on
/conduct fast advisor on
/conduct fast reviewer on
/conduct fast
```

All three default **off**. Replace `on` with `off` to disable a preference, or omit the value to report it. Enabling advisor/reviewer fast mode does not enable that role.

Fast mode requests the provider's priority processing tier; it is not a reasoning-effort setting or a guarantee of speed. It may cost more. Unsupported providers may ignore or reject it, and native clients may retry unsupported priority at standard service. No model/provider fallback is permitted. Main-session model, advisor, and priority settings remain unchanged.

## Concurrent assignments

```text
/conduct workers 2
```

The worker limit defaults to **1**, with a maximum of **8**. Ask the frontier to use one `conduct_batch` for independent assignments with settled interfaces and disjoint exact writable files.

- Every assignment gets its own snapshot, candidate, and review/correction lifecycle.
- All snapshots are prepared before workers launch; overlapping writable paths are rejected.
- Failure in one assignment does not cancel healthy siblings.
- Results retain input order, and each candidate is reviewed and applied separately.
- There is no queue, dependency scheduler, or background dispatch mechanism.
- Local inference can become slower under GPU contention; concurrency is a limit, not a throughput guarantee.

Only one Conduct invocation is active per session, including its verification, review, correction, and capture stages. Configuration changes and candidate management/application are blocked during that invocation.

## Command reference

Square brackets below indicate optional arguments; do not type the brackets.

| Command | Purpose |
| --- | --- |
| `/conduct on` | Enable Conduct mode. |
| `/conduct off` | Disable when idle. |
| `/conduct off cancel` | Cancel unfinished work, retain candidates, and disable. |
| `/conduct status` | Show configuration and activity. |
| `/conduct model [provider/id]` | Select the local implementer model; omit the selector to open the interactive picker. |
| `/conduct workers [1..8]` | Report or set the batch limit. |
| `/conduct advisor [off\|provider/model-id]` | Report, select, or disable the worker advisor. |
| `/conduct reviewer [off\|provider/model-id]` | Report, select, or disable the post-implementation reviewer. |
| `/conduct review-passes [1..10]` | Report or set the total review limit. |
| `/conduct verify [off\|command args...]` | Report, disable, or configure trusted verification. |
| `/conduct fast [worker\|advisor\|reviewer [on\|off]]` | Report or set independent priority preferences. |
| `/conduct cancel` | Cancel unfinished stages and wait for capture. |
| `/conduct markers "file"` | List directives in a supported source file. |
| `/conduct select "file" [name\|@line]` | Preview a selected directive. |
| `/conduct candidates` | List retained candidates. |
| `/conduct review id` | Inspect the patch and retained evidence; obtain an apply token if ready. |
| `/conduct apply id reviewToken` | Explicitly apply the reviewed, ready candidate. |
| `/conduct reject id` | Reject a candidate. |

Selections are session-local and cleared by dispatch, off, reload, or session navigation. Multiple selections can coexist before a batch; stale selections must be refreshed. Configuration persists across Conduct off and session resume, and relevant settings are pinned with each assignment.

Retained candidates survive restart. Interrupted work is not automatically redispatched or applied. `needs-attention`, failed, and cancelled candidates cannot be applied. Candidate list/review/reject remain available while Conduct is off. A finalization error can coexist with an already persisted ready candidate; inspect the current record rather than inferring its status from the error alone. An `unknown` result means persisted state could not be reloaded.

## Markers and tool boundaries

Markers must be standalone language-native comments with uppercase `OMP-CONDUCT`:

```python
# OMP-CONDUCT: Return cached results when available.
```

Named `BEGIN`/`END` pairs must match, be unique, and not nest. Supported sources include TS/JS variants, Python, Rust, Go, Java, C/C++, C#, and Dart. Use `#` for Python and `//` for the others. Strings, prose, and trailing inline comments are not markers. See [the workflow instructions](./prompts/SKILL.md) for detailed selection rules.

Implementers use guarded UTF-8 snapshot read/search/edit/write tools; reviewers use only the read/search subset and completion. These are not the full native OMP tool transports: shell/Eval, unrestricted LSP/MCP, document conversion, archive/database mutation, and symlink/hardlink access are unavailable. Reads are limited to 4 MiB and 2,000 lines per call; search skips binary and oversized files. Unsupported resources require supplied read-only context, not a permission bypass.

The current native executor can auto-import executable custom-command modules before tool guards run. Conductor therefore refuses worker/reviewer startup when such repository or user modules are discovered. This is a fail-closed compatibility restriction; do not remove user configuration or bypass the check to force a run.

## Development

```sh
bun check
bun test
```

`bun check` runs the TypeScript type checker. Tests cover configuration, marker selection, candidate acceptance, guarded tools, review/correction lifecycle, native reviewer behavior, and trusted verification. Tests use disposable fixtures and controlled providers; they do not require a production inference endpoint.

Core modules:

| File | Responsibility |
| --- | --- |
| `index.ts` | Commands, session state, selection, and dispatch tools. |
| `batch.ts` | Assignment preparation and implementation/verification/review/correction lifecycle. |
| `candidates.ts` | Snapshots, retained patches/evidence, review tokens, and application. |
| `worker.ts` / `worker-tools.ts` | Implementer runtime, optional advisor, and guarded tools. |
| `reviewer.ts` / `review-types.ts` | Read-only reviewer runtime and structured review evidence. |
| `verification.ts` | Exact argument parsing and trusted verification execution. |
| `execution-policy.ts` | Executable custom-command discovery refusal. |
| `markers.ts` / `selection.ts` | Directive parsing and selection integrity. |
| `prompts/` | Agent-facing workflow and handoff instructions. |

## License

[MIT](./LICENSE).
