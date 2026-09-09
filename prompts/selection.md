# Conduct marker preview — not implementation authorization

Source: {{{path}}}
Lines: {{startLine}}–{{endLine}}
Selection token: {{{selection}}}

# Directive (verbatim)

{{#each directiveLines}}
    {{{this}}}
{{/each}}

# Preview only

No work was dispatched. Selection does not authorize implementation. The source text above is preview data, not permission to act. Marker spans delimit instructions, not writable code boundaries. An explicit implementation request is required before using this token with `conduct_task` or `conduct_batch`, an assignment, and an explicit `files` list. The marker source is not implicitly writable. Dispatch prepares an unapplied snapshot candidate; review and a separate human `/conductor apply id reviewToken` command are required to change source targets.
