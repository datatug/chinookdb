// The environment for every git call a check or a test makes: all inherited GIT_* variables are dropped.
// git sets GIT_DIR and GIT_INDEX_FILE (and more) for a hook it runs from a linked worktree, and a call that
// inherits them would act on that repository instead of the one named with -C. Callers still pass -C.
export function cleanGitEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
}

// The environment for the test suite's git calls: cleanGitEnv, and no configuration of the machine it runs on.
// A global `commit.gpgsign = true` would fail every scratch commit, and a global `core.hooksPath` would run the
// developer's hooks inside scratch repositories. GIT_CONFIG_GLOBAL needs git 2.32 or later (it replaces both
// ~/.gitconfig and $XDG_CONFIG_HOME/git/config); GIT_TERMINAL_PROMPT=0 so that nothing ever waits for a password.
export function isolatedGitEnv(env = process.env) {
  return { ...cleanGitEnv(env), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}
