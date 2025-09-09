export { runRules } from './engine.js';
export type { GuardMode, GuardContext, Rule } from './types.js';
// Re-export guard rules and option types from dep-fence 0.3.x
export {
  mtimeCompareRule,
  type MtimeCompareOptions,
  upstreamConflictRule,
  type UpstreamConflictOptions,
  allowedDirsRule,
  type AllowedDirsOptions,
} from 'dep-fence/guards';
