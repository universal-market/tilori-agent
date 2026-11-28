// The Claude Code adapter's single entry point (UNI-1178 S1b). Core imports the
// host only through this file, via src/host.ts.
import type { HostAdapter } from '../../host.ts';
import { claudeBinary, claudePluginIO } from './plugin-io.ts';
import { claudeRuleCheck } from './rule-check.ts';
import { claudeText } from './text.ts';

export const claudeAdapter: HostAdapter = {
  id: 'claude',
  text: claudeText,
  pluginIO: claudePluginIO,
  ruleCheck: claudeRuleCheck,
  binary: claudeBinary,
};
