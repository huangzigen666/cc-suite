// Narrow local overlay: no reference-source writes, no provider/config changes.
function replace(text, before, after) {
  if (text.includes(after)) return text;
  if (text.split(before).length !== 2) throw new Error("Unexpected rex-lang-bridge baseline; refusing patch");
  return text.replace(before, after);
}
export function bridgeOverlay(relative, text) {
  if (relative === "scripts/cli.mjs") {
    text = replace(text, "  --dry-run                 No network, credentials, or history writes", "  --delegation              Translate task payload; no summary or history\n  --dry-run                 No network, credentials, or history writes");
    text = replace(text, "['--json', '--hook-json', '--dry-run', '--config', '--today', '--help']", "['--json', '--hook-json', '--dry-run', '--delegation', '--config', '--today', '--help']");
    return replace(text, "{ dryRun: Boolean(options['dry-run']), response }", "{ dryRun: Boolean(options['dry-run']), delegation: Boolean(options.delegation), response }");
  }
  if (relative === "scripts/lib/bridge.mjs") {
    text = replace(text, "{ dryRun = false, response, home, env, ...modelOptions }", "{ dryRun = false, delegation = false, response, home, env, ...modelOptions }");
    text = replace(text, "  const original = input.prompt;", "  if (delegation) { config.summary_language = false; config.show_translation = false; config.history_enabled = false; }\n  const original = input.prompt;");
    return replace(text, "  const { mode, text } = detectMode(original, config);", "  const { mode, text } = delegation\n    ? { mode: config.auto_translate !== false && /\\p{Script=Han}/u.test(original) ? 'translate' : 'skip', text: original }\n    : detectMode(original, config);");
  }
  if (relative === "scripts/prompt-bridge-hook.mjs") {
    return replace(text, "  const result = await bridge(input);\n  emit(result.hook);", "  if (process.env.REX_LANG_BRIDGE_ACTIVE === '1' || input.prompt.includes('[cc-suite rex-lang-bridge v1]')) {\n    emit({});\n  } else {\n    const result = await bridge(input);\n    emit(result.hook);\n  }");
  }
  if (relative === "scripts/lib/translate-codex.mjs") {
    return replace(text, "      env,", "      env: { ...env, REX_LANG_BRIDGE_ACTIVE: '1' },");
  }
  throw new Error("Unknown overlay file");
}
export const overlayFiles = ["scripts/cli.mjs", "scripts/lib/bridge.mjs", "scripts/prompt-bridge-hook.mjs", "scripts/lib/translate-codex.mjs"];
