Implement explicitly requested deferred work with one local Conduct worker; returns synchronously when that worker finishes.

<critical>
- Use ONLY while Conduct is enabled and the user explicitly requests implementation; NEVER auto-dispatch discovered TODOs.
- Supply exactly one of `selection` or `directive`, plus `assignment` and required `files`: exact writable files, cwd-relative or absolute within the Git repository, never globs or directories. User-referenced marker? Obtain the opaque `selection` through `conduct_select` on the user-named file. Freeform request? Preserve the human text verbatim in `directive`.
- Selection/preview is not authorization. Stale selection? Reselect and read updated intent; NEVER copy old text into `directive` to bypass rejection.
- Read surrounding code and callers; supply implementation targets, read-only context, acceptance criteria, and fixed versus inferred decisions in `assignment`. Marker spans delimit instructions, not edit boundaries.
- Require a Git repository and saved files. Worker edits a copied snapshot; results are retained unapplied candidates, including partial failed/cancelled work. This is workflow protection, not an OS sandbox.
- A marker source is not implicitly writable; include it in `files` only if it needs modification. Snapshot selection mismatches require reselection.
- Inspect the returned candidate's actual patch using `conduct_candidate`, review correctness, then ask the human to run the exact returned `/conduct apply id reviewToken` command. Never apply through another tool or accept worker reports as evidence.
- Source changes make candidates stale; keep targets idle during application. After human application, perform targeted runtime verification before claiming completion. The worker cannot execute runtime verification.
</critical>
