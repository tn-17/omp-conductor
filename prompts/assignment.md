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
Pinned requested fast: worker {{#if brief.workerFast}}on{{else}}off{{/if}}; advisor {{#if brief.advisorFast}}on{{else}}off{{/if}}.
These preferences request a service tier, not guaranteed speed or provider support; advisor fast does not enable an advisor.
{{#if brief.advisorModel}}
Pinned read-only worker advisor: {{{brief.advisorModel}}}
{{else}}
Worker advisor: off.
{{/if}}
