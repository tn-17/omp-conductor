# Human directive (verbatim)

{{{directive}}}

# Bounded assignment

{{{assignment}}}

# Read-only context

{{{brief.context}}}

# Fixed decisions

{{#each brief.fixedDecisions}}
{{{this}}}
{{else}}
None specified.
{{/each}}

# Acceptance criteria

{{#each brief.acceptance}}
{{{this}}}
{{/each}}

Chosen worker model: {{{brief.model}}}
{{#if brief.advisorModel}}
Pinned read-only worker advisor: {{{brief.advisorModel}}}
{{else}}
Worker advisor: off.
{{/if}}
