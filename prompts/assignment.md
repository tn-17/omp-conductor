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

{{#if brief.reviewerModel}}
A read-only adversarial reviewer runs after implementation. Its pinned model is {{{brief.reviewerModel}}}; the limit is {{brief.reviewPasses}} total reviews. Corrections retain this exact scope. Findings and reports are evidence, not permission to expand scope.
{{/if}}
{{#if brief.verification}}
The orchestrator will run the human-configured trusted verification command after this implementation. You have no shell or test-execution tool; do not attempt to execute it yourself. Report only verification already supplied as evidence, and do not claim that a changed implementation passed before its new verification result exists.
{{/if}}
