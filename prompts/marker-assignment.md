{{#if path}}
The original directive was extracted from snapshot cwd-relative source {{{path}}}, lines {{startLine}}–{{endLine}}. This source is read-only unless explicitly included in the exact writable files. Read its surrounding implementation before editing. Never resolve this source against the original workspace.
{{/if}}

Frontier assignment:
{{{assignment}}}

Snapshot root: {{{root}}}
Tool working directory: {{{cwd}}}

Exact writable files (snapshot-root-relative):
{{#each files}}
{{{this}}}
{{/each}}
The same exact writable files, relative to the tool working directory:
{{#each cwdFiles}}
{{{this}}}
{{/each}}
All other files are read-only context. Only paths inside this snapshot are accessible.
