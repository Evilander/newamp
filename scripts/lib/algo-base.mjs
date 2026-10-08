export function algorithmComparisonBase(argv, env, git) {
  const index = argv.indexOf('--base');
  if (index >= 0) {
    if (!argv[index + 1]) throw new Error('--base requires a commit or ref');
    return argv[index + 1];
  }
  const supplied = env.NEWAMP_ALGO_BASE?.trim();
  // CI supplies the commit the push started from. After a force-push that
  // commit is no longer in the history, so it is only used if it resolves;
  // otherwise the comparison falls back to the CI default below.
  if (supplied && !/^0+$/.test(supplied) && git(['rev-parse', '--verify', `${supplied}^{commit}`])) {
    return supplied;
  }
  if (env.CI && env.CI !== 'false') {
    if (env.GITHUB_REF_TYPE === 'tag') return git(['describe', '--tags', '--abbrev=0', 'HEAD^'])?.trim() || 'HEAD^';
    return 'HEAD^';
  }
  return 'HEAD';
}
