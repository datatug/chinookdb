// The environment for every git call a check or a test makes: all inherited GIT_* variables are dropped.
// git sets GIT_DIR and GIT_INDEX_FILE (and more) for a hook it runs from a linked worktree, and a call that
// inherits them would act on that repository instead of the one named with -C. Callers still pass -C.
export function cleanGitEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
}
