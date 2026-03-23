/**
 * Optional git global options that may appear between `git` and the subcommand.
 * Must match `GIT_GLOBAL_OPTS` in `hooks/utils/shell-patterns.ts` (see sync test).
 */
export const GIT_GLOBAL_OPTS = String.raw`(?:(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace)(?:=\S+|\s+\S+)|--?\S+)\s+)*`
