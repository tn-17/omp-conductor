{{#if path}}
The original directive was extracted from snapshot cwd-relative source {{{path}}}, lines {{startLine}}–{{endLine}}. This source is read-only unless explicitly included in the exact writable files. Read its surrounding implementation before editing. Never resolve this source against the original workspace.
{{/if}}

Frontier assignment:
{{{assignment}}}

Exact writable files (repository-relative):
{{#each files}}
{{{this}}}
{{/each}}
All other files are read-only context.
