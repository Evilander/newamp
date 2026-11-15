// Windows cannot execute a script, shebang or not (spawn answers EFTYPE), so a
// stand-in ffmpeg that is a *.mjs file is started under node there. This esbuild
// plugin swaps the `spawn` of the bundled code to do that. Everywhere else it
// does nothing and the shebang runs the stand-in, as before.

export const scriptStandInSpawn = {
  name: 'script-stand-in-spawn',
  setup(b) {
    if (process.platform !== 'win32') return;
    b.onResolve({ filter: /^node:child_process$/ }, () => ({ path: 'child-process', namespace: 'script-stand-in' }));
    b.onLoad({ filter: /.*/, namespace: 'script-stand-in' }, () => ({
      contents: `
        import * as real from 'child_process';
        export * from 'child_process';
        export function spawn(command, args, options) {
          return String(command).endsWith('.mjs')
            ? real.spawn(process.execPath, [command, ...args], options)
            : real.spawn(command, args, options);
        }`,
      loader: 'js',
    }));
  },
};
