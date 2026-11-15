// Runs the real RadioView against stand-ins for everything outside it: the audio
// element, the player store, the clock and the station directory. The repo has no
// DOM test runner, so the view renders through the hook harness and the tests
// drive it the way a person would, by typing, clicking and starting library
// playback, then read the tree and the element back.
import { bundleComponent, mount } from './hook-harness.mjs';

// Elements anywhere in a rendered tree, including ones passed as props such as the header's actions.
function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (!('type' in node && 'props' in node)) return found;
  if (predicate(node)) found.push(node);
  for (const value of Object.values(node.props ?? {})) findAll(value, predicate, found);
  return found;
}

export function abortError() {
  return Object.assign(new Error('The play() request was interrupted by a new load request.'), { name: 'AbortError' });
}

export function unsupportedError() {
  return Object.assign(new Error('The element has no supported sources.'), { name: 'NotSupportedError' });
}

function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, delay = 0) {
      const id = nextId++;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** Runs every timer due within `ms`, oldest first, including ones those timers schedule. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = end;
    },
  };
}

class FakeAudio {
  constructor() {
    this.listeners = new Map();
    this.plays = [];
    this.paused = true;
    this.volume = 1;
    this.error = null;
    // A new load interrupts the play() before it, which is what a real element does.
    this.abortOnLoad = true;
    this.currentSrc = '';
    this.sinks = [];
  }

  get src() {
    return this.currentSrc;
  }

  set src(value) {
    this.currentSrc = value;
    if (this.abortOnLoad) this.settlePending((play) => play.reject(abortError()));
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }

  emit(type) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type });
  }

  play() {
    return new Promise((resolve, reject) => {
      this.plays.push({
        done: false,
        resolve: () => {
          this.paused = false;
          resolve();
        },
        reject,
      });
    });
  }

  pause() {
    this.paused = true;
  }

  setSinkId(deviceId) {
    this.sinks.push(deviceId);
    return Promise.resolve();
  }

  settlePending(settle) {
    for (const play of this.plays) {
      if (play.done) continue;
      play.done = true;
      settle(play);
    }
  }

  /** Settles play() call `index`, the way the network eventually answers it. */
  answer(index, error = null) {
    const play = this.plays[index];
    play.done = true;
    if (error) play.reject(error);
    else play.resolve();
  }
}

function createStore() {
  const listeners = new Set();
  const store = {
    pauses: 0,
    state: null,
    set(patch) {
      const previous = store.state;
      store.state = { ...previous, ...patch };
      for (const listener of [...listeners]) listener(store.state, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  store.state = {
    isPlaying: false,
    volume: 0.5,
    settings: { audioOutputDeviceId: null },
    engine: {
      pause() {
        store.pauses += 1;
        store.set({ isPlaying: false });
      },
    },
  };
  return store;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
let rigs = 0;

/**
 * A fresh RadioView module with its own element, store and clock. `stations` is
 * what the directory answers every search with.
 */
export async function createRadioRig({ stations = [] } = {}) {
  const run = ++rigs;
  const clock = createClock();
  const store = createStore();
  const toasts = [];
  const clicks = [];
  const requests = [];
  const audios = [];
  const realFetch = globalThis.fetch;
  const previous = {
    window: globalThis.window,
    Audio: globalThis.Audio,
    rig: globalThis.__radioRig,
  };
  globalThis.__radioRig = { store, toasts };
  globalThis.window = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  globalThis.Audio = class extends FakeAudio {
    constructor() {
      super();
      audios.push(this);
    }
  };
  globalThis.fetch = async (url) => {
    const { pathname, searchParams } = new URL(url);
    requests.push({ pathname, searchParams });
    if (pathname.startsWith('/json/url/')) clicks.push(pathname.slice('/json/url/'.length));
    const rows = pathname === '/json/stations/search' ? stations : [];
    return { ok: true, status: 200, json: async () => rows };
  };

  // A different stub text per run is a different module, so no state is shared between runs. The
  // run number has to be a value the bundle keeps; a comment would be stripped.
  const { RadioView } = await bundleComponent('src/components/views/RadioView.tsx', {
    '../../store/usePlayerStore': `const rig = () => globalThis.__radioRig.store;
      export const usePlayerStore = Object.assign((select) => select(rig().state), {
        run: ${run},
        getState: () => rig().state,
        subscribe: (listener) => rig().subscribe(listener),
      });`,
    '../../audio/engine': 'export const volumePositionToGain = (position) => position;',
    '../../lib/toast': 'export const pushToast = (toast) => { globalThis.__radioRig.toasts.push(toast); };',
    '../ViewHeader': 'export const ViewHeader = () => null;',
    '../Icons': 'export const Antenna = () => null;',
  });

  let view = mount(() => RadioView());
  view.flush();

  const text = (node) => {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(text).join('');
    return text(node.props?.children);
  };

  const rig = {
    clock,
    store,
    toasts,
    clicks,
    requests,
    get view() {
      return view;
    },
    /** Mounts the view again, as navigating back to Radio does; the old one is unmounted first. */
    remount() {
      view.unmount();
      view = mount(() => RadioView());
      view.flush();
    },
    /** The one shared audio element, once the view has mounted. */
    get audio() {
      return audios[0];
    },
    settle,
    /** Changes the player store and renders the view again, as the store's subscription does in the app. */
    player(patch) {
      store.set(patch);
      view.flush();
    },
    async flush() {
      await settle();
      view.flush();
    },
    /** Types a search and lets the directory answer. */
    async search(query) {
      findAll(view.output, (node) => node.type === 'input')[0].props.onChange({ target: { value: query }, currentTarget: { value: query } });
      view.flush();
      clock.advance(300);
      await rig.flush();
    },
    rows() {
      return findAll(view.output, (node) => node.type === 'li');
    },
    /** The play/stop button of the station list's row `index`. */
    rowButton(index) {
      return findAll(rig.rows()[index], (node) => node.type === 'button')[0];
    },
    /** The button whose label is exactly `label`, such as a genre chip. */
    buttonByText(label) {
      return findAll(view.output, (node) => node.type === 'button' && text(node.props.children) === label)[0];
    },
    click(button) {
      button.props.onClick({});
      view.flush();
    },
    isLive() {
      return text(view.output).includes('LIVE');
    },
    isConnecting() {
      return text(view.output).includes('Connecting to');
    },
    dispose() {
      view.unmount();
      globalThis.fetch = realFetch;
      globalThis.window = previous.window;
      globalThis.Audio = previous.Audio;
      globalThis.__radioRig = previous.rig;
    },
  };
  return rig;
}

export function directoryStation(id, extra = {}) {
  return {
    stationuuid: id,
    name: `Station ${id}`,
    url_resolved: `http://example.test/${id}`,
    homepage: '',
    favicon: '',
    country: '',
    language: '',
    tags: '',
    bitrate: 128,
    codec: 'MP3',
    ...extra,
  };
}
