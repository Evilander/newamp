export function electronBuilderTargetArgs(args, platform = process.platform) {
  if (args.includes('--portable')) return [['--win=portable']];
  if (args.includes('--installer') || args.includes('--nsis')) return [['--win=nsis']];
  if (args.includes('--linux')) return [['--linux=tar.gz']];
  if (args.includes('--mac')) return [['--mac', '--arm64'], ['--mac', '--x64']];
  if (args.includes('--win')) return [['--win=nsis'], ['--win=portable']];
  if (args.includes('--all')) return [['--win=nsis'], ['--win=portable'], ['--linux=tar.gz']];
  if (platform === 'darwin') return [['--mac', '--arm64'], ['--mac', '--x64']];
  if (platform === 'linux') return [['--linux=tar.gz']];
  if (platform === 'win32') return [['--win=nsis'], ['--win=portable']];
  throw new Error(`Unsupported packaging platform: ${platform}`);
}

export function nativeBuildArgs(target, hostArch = process.arch) {
  const arch = target.includes('--arm64') ? 'arm64' : target.includes('--x64') ? 'x64' : hostArch;
  return ['--force', `--arch=${arch}`];
}
