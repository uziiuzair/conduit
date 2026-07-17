// Claude Code interpolates ${user_config.*} into hook env as CONTINUITY_*;
// older runtimes export CLAUDE_PLUGIN_OPTION_* forms instead. Try both.

export function repoAllowlistFromEnv() {
  return (
    process.env.CONTINUITY_REPO_ALLOWLIST ??
    process.env.CLAUDE_PLUGIN_OPTION_REPOALLOWLIST ??
    process.env.CLAUDE_PLUGIN_OPTION_REPO_ALLOWLIST
  )
}

export function collisionGuardFromEnv() {
  return (
    process.env.CONTINUITY_COLLISION_GUARD ??
    process.env.CLAUDE_PLUGIN_OPTION_COLLISIONGUARD ??
    process.env.CLAUDE_PLUGIN_OPTION_COLLISION_GUARD
  )
}
