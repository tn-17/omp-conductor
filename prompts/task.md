Implement explicitly requested deferred work with one local Conduct worker; returns synchronously when that worker finishes.

<critical>
- Use ONLY while Conduct is enabled and the user explicitly requests implementation; NEVER auto-dispatch discovered TODOs.
- Preserve the human directive verbatim. Supply target/context, acceptance criteria, and fixed versus inferred decisions in the assignment.
- Worker edits the current disk/shared workspace without isolation or hard file-scope enforcement. Warn the user to save buffers and use a disposable workspace before calling; NEVER edit concurrently.
- Wait for completion, then read actual changes and perform targeted runtime verification before claiming completion. The worker cannot execute runtime verification.
</critical>
