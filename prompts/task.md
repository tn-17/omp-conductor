Implement explicitly requested deferred work with one local Conduct worker; returns synchronously when that worker finishes.

<critical>
- Use ONLY while Conduct is enabled and the user explicitly requests implementation; NEVER auto-dispatch discovered TODOs.
- Supply exactly one of `selection` or `directive`, plus `assignment`, required `context`, `fixedDecisions` (string array; empty only if none), nonempty `acceptance` (observable criteria array), and required `files`: exact writable files, cwd-relative or absolute within the Git repository, never globs or directories. User-referenced marker? Obtain the opaque `selection` through `conduct_select` on the user-named file. Freeform request? Preserve the human text verbatim in `directive`. These fields and the chosen model are retained with the candidate for review.
- Selection/preview is not authorization. Stale selection? Reselect and read updated intent; NEVER copy old text into `directive` to bypass rejection.
- Read surrounding code and callers; put the implementation task in `assignment`, read-only evidence and labeled inferences in `context`, fixed requirements in `fixedDecisions`, and observable expected behavior in `acceptance`. Marker spans delimit instructions, not edit boundaries.
- Worker tool access is limited to `conduct_read`, `conduct_grep`, `conduct_glob`, `conduct_edit`, `conduct_write`, plus native completion. Scope cannot be widened by the worker. If it reports additional required files, ask the human to authorize those exact files and reason, reject the old candidate through `/conduct reject id`, and dispatch a fresh candidate with the newly authorized scope. Never silently widen or reuse the old candidate.
- Require a Git repository and saved files. Worker edits a copied snapshot; results are retained unapplied candidates, including partial failed/cancelled work. This is workflow protection, not an OS sandbox.
- A marker source is not implicitly writable; include it in `files` only if it needs modification. Snapshot selection mismatches require reselection.
- Inspect the returned candidate's actual patch using `conduct_candidate`, review correctness, then ask the human to run the exact returned `/conduct apply id reviewToken` command. Never apply through another tool or accept worker reports as evidence.
- Source changes make candidates stale; keep targets idle during application. After human application, perform targeted runtime verification before claiming completion. The worker cannot execute runtime verification.
</critical>
