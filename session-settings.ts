import { Settings } from "@oh-my-pi/pi-coding-agent";

export interface IsolatedSettingsOptions {
  model: string;
  advisorModel?: string;
  subagentTier: "none" | "priority";
  advisorTier: "none" | "priority";
}

/**
 * Build a fresh session settings instance with every Conduct safety pin
 * explicit. Only model selection and service tiers vary by session kind.
 */
export function createIsolatedSettings(options: IsolatedSettingsOptions): Settings {
  return Settings.isolated({
    modelRoles: {
      default: options.model,
      task: options.model,
      smol: options.model,
      slow: options.model,
      vision: options.model,
      ...(options.advisorModel ? { advisor: options.advisorModel } : {}),
    },
    "tier.subagent": options.subagentTier,
    "tier.advisor": options.advisorTier,
    "task.agentModelOverrides": {},
    "task.agentAdvisor": {},
    "task.agentPrewalk": {},
    "task.maxRecursionDepth": 1,
    "task.prewalk": false,
    "advisor.enabled": false,
    "prewalk.enabled": false,
    "retry.modelFallback": false,
    "retry.usageAwareFallback": false,
    "retry.fallbackChains": {},
    "compaction.enabled": false,
    "contextPromotion.enabled": false,
    "recap.enabled": false,
    "branchSummary.enabled": false,
    "memory.backend": "off",
    "autolearn.enabled": false,
    "images.blockImages": true,
    "images.describeForTextModels": false,
    "images.urls.enabled": false,
    "fetch.enabled": false,
    "read.summarize.enabled": false,
    "edit.autoRepair.enabled": false,
    "edit.blackbox.enabled": false,
    "magicKeywords.enabled": false,
  });
}
