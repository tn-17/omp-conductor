Implement explicitly requested deferred work with one local Conduct worker; returns synchronously when that worker finishes.

<critical>
- Use ONLY while Conduct is enabled and the user explicitly requests implementation; NEVER auto-dispatch discovered TODOs.
- Supply exactly one of `selection` or `directive`, plus `assignment`. User-referenced marker? Obtain the opaque `selection` through `conduct_select` on the user-named file. Freeform request? Preserve the human text verbatim in `directive`.
- Selection/preview is not authorization. Stale selection? Reselect and read updated intent; NEVER copy old text into `directive` to bypass rejection.
- Read surrounding code and callers; supply implementation targets, read-only context, acceptance criteria, and fixed versus inferred decisions in `assignment`. Marker spans delimit instructions, not edit boundaries.
- Worker edits the current disk/shared workspace without isolation or hard file-scope enforcement. Warn the user to save buffers and use a disposable workspace before calling; NEVER edit concurrently.
- Wait for completion, then read actual changes and perform targeted runtime verification before claiming completion. The worker cannot execute runtime verification.
</critical>
