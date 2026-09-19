// Butterchurn 2.6.7 allocates each MilkDrop megabuf as
// `new Array(1048576).fill(0)`: 8 MB written element by element, for the
// preset, the global buffer and every enabled wave and shape, on every preset
// change, whether or not the preset ever touches megabuf. That was most of a
// preset switch's cost in Eviland Live. A Float64Array reads the same to
// preset code (numbers, zeroed, same indexing, shared by reference through
// butterchurn's shallow cloneVars) and the OS zeroes its pages lazily.
//
// Applied at bundle time. butterchurn is pinned to an exact version (the Live
// pipeline also hooks its private renderer), and the patch fails the build if
// the allocation it rewrites ever changes shape.

const ALLOCATION = 'new Array(1048576).fill(0)';
const EXPECTED_SITES = 4;
const BUTTERCHURN_ENTRY = /[\\/]node_modules[\\/]butterchurn[\\/]lib[\\/]butterchurn\.js$/;

export function patchButterchurnMegabufs(code) {
  const sites = code.split(ALLOCATION).length - 1;
  if (sites !== EXPECTED_SITES) {
    throw new Error(
      `butterchurn megabuf patch: expected ${EXPECTED_SITES} allocations, found ${sites}. ` +
        'Re-check scripts/butterchurn-megabuf.mjs against this butterchurn version.',
    );
  }
  return code.replaceAll(ALLOCATION, 'new Float64Array(1048576)');
}

export function butterchurnMegabufVitePlugin() {
  return {
    name: 'newamp-butterchurn-megabuf',
    transform(code, id) {
      if (!BUTTERCHURN_ENTRY.test(id)) return null;
      return { code: patchButterchurnMegabufs(code), map: null };
    },
  };
}

export function butterchurnMegabufEsbuildPlugin() {
  return {
    name: 'newamp-butterchurn-megabuf',
    setup(build) {
      build.onLoad({ filter: BUTTERCHURN_ENTRY }, async (args) => {
        const { readFile } = await import('node:fs/promises');
        return { contents: patchButterchurnMegabufs(await readFile(args.path, 'utf8')), loader: 'js' };
      });
    },
  };
}
