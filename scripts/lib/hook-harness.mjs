// Renders a React component against a stub of React's hooks, because the repo
// has no DOM test runner. Slots persist between renders, a state setter marks
// the tree dirty so flush() renders again, and an effect re-runs only when its
// deps change (cleaning up first).
import { build } from 'esbuild';

const REACT_STUB = `
export function useState(initial) {
  const h = globalThis.__hooks;
  const i = h.index++;
  if (!(i in h.slots)) h.slots[i] = { value: typeof initial === 'function' ? initial() : initial };
  const slot = h.slots[i];
  return [slot.value, (next) => {
    const value = typeof next === 'function' ? next(slot.value) : next;
    if (Object.is(value, slot.value)) return;
    slot.value = value;
    h.dirty = true;
  }];
}
export function useEffect(fn, deps) { const h = globalThis.__hooks; h.effects.push({ index: h.index++, fn, deps }); }
`;

const JSX_STUB = `
export function jsx(type, props) { return { type, props }; }
export const jsxs = jsx;
export const Fragment = Symbol('Fragment');
`;

/**
 * Bundles a component with `modules` standing in for its imports. Keys are the
 * specifiers exactly as the component writes them; values are module source.
 */
export async function bundleComponent(entry, modules = {}) {
  const stubs = { react: REACT_STUB, 'react/jsx-runtime': JSX_STUB, ...modules };
  const virtualModules = {
    name: 'virtual-modules',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => (Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'virtual' } : undefined));
      b.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => ({ loader: 'js', contents: stubs[args.path] }));
    },
  };
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [virtualModules],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

export function mount(component) {
  const hooks = { slots: [], index: 0, effects: [], deps: [], cleanups: [], dirty: false };
  let output = null;
  const pass = () => {
    globalThis.__hooks = hooks;
    hooks.index = 0;
    hooks.effects = [];
    hooks.dirty = false;
    output = component();
    for (const effect of hooks.effects) {
      const previous = hooks.deps[effect.index];
      const changed = !previous || !effect.deps || effect.deps.length !== previous.length || effect.deps.some((dep, i) => !Object.is(dep, previous[i]));
      if (!changed) continue;
      hooks.cleanups[effect.index]?.();
      hooks.deps[effect.index] = effect.deps ?? [];
      const cleanup = effect.fn();
      hooks.cleanups[effect.index] = typeof cleanup === 'function' ? cleanup : undefined;
    }
  };
  return {
    get output() { return output; },
    /** Renders until nothing is left dirty. */
    flush() {
      for (let i = 0; i < 25; i += 1) {
        pass();
        if (!hooks.dirty) return output;
      }
      throw new Error('component keeps re-rendering');
    },
    unmount() {
      for (const cleanup of hooks.cleanups) cleanup?.();
      hooks.cleanups = [];
    },
  };
}

/** Every element in a rendered tree that satisfies `predicate`. */
export function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (predicate(node)) found.push(node);
  findAll(node.props?.children, predicate, found);
  return found;
}
