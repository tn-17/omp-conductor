Read-only lookup of `OMP-CONDUCT` directives in a file explicitly named by the user.

- Path alone lists markers when multiple exist, or selects the only marker. Explicit selection uses `marker` for a case-sensitive pair name or `line` for a marker's starting line; NEVER supply both.
- Selection returns marker text verbatim and an opaque token for `conduct_task.selection`. MUST read surrounding code and relevant callers to infer implementation targets and read-only context; marker spans are instructions, not edit boundaries.
- Stale token? MUST reselect and read updated intent; NEVER bypass rejection by copying old text into `directive`.

<critical>
Lookup and preview NEVER dispatch work or authorize implementation. MUST obtain an explicit implementation request before passing the selection to `conduct_task` with an assignment and an explicit `files` list. The selected source is not implicitly writable; dispatch prepares an unapplied snapshot candidate, never human approval. NEVER discover or implement unrelated markers automatically.
</critical>
