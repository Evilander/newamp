// A WebGL2 context that runs in Node: every call is recorded, resources are
// tracked, and nothing is drawn. It exists to test the renderers' own logic
// (what they allocate, when, what they upload, how they survive a lost
// context), not what a GPU would make of their shaders.
//
// Behaviour that matters to those tests:
//   - lose() / restore() act like a real context loss. While lost every call
//     is a no-op and creators return null; after restore() the context object
//     is the same but anything made before the loss is stale, and using it is
//     counted in log.stale.
//   - failures can be injected: framebuffers over maxFboPixels are incomplete,
//     and linkFails() can reject programs.
//   - a program is found by a piece of its source (find), uniforms by name.

const TEXTURE0 = 33984;
const KNOWN = { FRAMEBUFFER_COMPLETE: 36053, LINK_STATUS: 35714, COMPILE_STATUS: 35713, MAX_TEXTURE_SIZE: 3379, MAX_VIEWPORT_DIMS: 3386, COLOR_CLEAR_VALUE: 3106 };

export class FakeCanvas extends EventTarget {
  constructor(options = {}) {
    super();
    this.width = 300;
    this.height = 150;
    this.style = {};
    this.options = options;
    this.fake = null;
  }
  getContext(kind) {
    if (kind !== 'webgl2') return null;
    this.fake ??= createFakeGl(this, this.options);
    return this.fake.gl;
  }
  getBoundingClientRect() {
    return { width: this.width, height: this.height, left: 0, top: 0, right: this.width, bottom: this.height };
  }
}

export function createFakeGl(canvas, options = {}) {
  const log = {
    calls: {},
    draws: [],
    programs: [],
    stale: 0,
    doubleDelete: 0,
    loseContext: 0,
    uniformWrites: [],
  };
  let generation = 0;
  let nextId = 1;
  let lost = false;
  let program = null;
  let fbo = null;
  let unit = 0;
  const bound = [];
  const constants = new Map();
  let nextConstant = 1000;
  const attribs = new Map();
  const maxFboPixels = () => (typeof options.maxFboPixels === 'function' ? options.maxFboPixels() : options.maxFboPixels ?? Infinity);

  const constant = (name) => {
    if (/^TEXTURE\d+$/.test(name)) return TEXTURE0 + Number(name.slice(7));
    if (KNOWN[name] !== undefined) return KNOWN[name];
    if (!constants.has(name)) constants.set(name, nextConstant++);
    return constants.get(name);
  };

  const touch = (value) => {
    if (value && typeof value === 'object' && value.gen !== undefined && value.gen !== generation) log.stale++;
  };
  const create = (kind) => {
    if (lost) return null;
    const resource = { kind, id: nextId++, gen: generation, deleted: false };
    if (kind === 'program') {
      resource.shaders = [];
      resource.uniforms = {};
      resource.linkFailed = false;
      log.programs.push(resource);
    }
    return resource;
  };

  const handlers = {
    createTexture: () => create('texture'),
    createFramebuffer: () => create('framebuffer'),
    createProgram: () => create('program'),
    createShader: (type) => {
      const shader = create('shader');
      if (shader) shader.type = type;
      return shader;
    },
    createBuffer: () => create('buffer'),
    createVertexArray: () => create('vao'),
    createTransformFeedback: () => create('feedback'),
    shaderSource: (shader, source) => { shader.source = source; },
    attachShader: (prog, shader) => { prog.shaders.push(shader); },
    linkProgram: (prog) => {
      prog.linkFailed = Boolean(options.linkFails?.(prog));
    },
    getShaderParameter: () => true,
    getProgramParameter: (prog, pname) => (pname === constant('LINK_STATUS') ? !prog.linkFailed : true),
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    getUniformLocation: (prog, name) => ({ kind: 'location', gen: generation, prog, name }),
    getAttribLocation: (prog, name) => {
      const key = `${prog.id}:${name}`;
      if (!attribs.has(key)) attribs.set(key, attribs.size);
      return attribs.get(key);
    },
    useProgram: (prog) => { program = prog; },
    bindFramebuffer: (_target, buffer) => { fbo = buffer; },
    framebufferTexture2D: (_target, _attachment, _texTarget, texture) => { if (fbo) fbo.texture = texture; },
    checkFramebufferStatus: () => {
      const texture = fbo?.texture;
      if (texture && texture.width * texture.height > maxFboPixels()) return 0;
      return constant('FRAMEBUFFER_COMPLETE');
    },
    activeTexture: (value) => { unit = value - TEXTURE0; },
    bindTexture: (_target, texture) => { bound[unit] = texture; },
    texImage2D: (...args) => {
      const texture = bound[unit];
      if (texture && args.length >= 9) {
        texture.width = args[3];
        texture.height = args[4];
      }
    },
    drawArrays: () => { log.draws.push({ program, fbo, texture: bound[0], instanced: false }); },
    drawArraysInstanced: () => { log.draws.push({ program, fbo, texture: bound[0], instanced: true }); },
    getExtension: (name) => {
      if (name === 'WEBGL_lose_context') return { loseContext: () => { log.loseContext++; }, restoreContext() {} };
      if (name === 'KHR_parallel_shader_compile') return options.parallelCompile ? { COMPLETION_STATUS_KHR: 37297 } : null;
      return {};
    },
    getParameter: (pname) => {
      if (pname === constant('MAX_TEXTURE_SIZE')) return options.maxTextureSize ?? 8192;
      if (pname === constant('MAX_VIEWPORT_DIMS')) return Int32Array.of(options.maxTextureSize ?? 8192, options.maxTextureSize ?? 8192);
      if (pname === constant('COLOR_CLEAR_VALUE')) return new Float32Array(4);
      return 0;
    },
    getError: () => 0,
  };
  for (const name of ['deleteTexture', 'deleteFramebuffer', 'deleteProgram', 'deleteShader', 'deleteBuffer', 'deleteVertexArray', 'deleteTransformFeedback']) {
    handlers[name] = (resource) => {
      if (!resource) return;
      if (resource.deleted) log.doubleDelete++;
      resource.deleted = true;
    };
  }
  for (const name of ['uniform1f', 'uniform1i', 'uniform2f', 'uniform3f', 'uniform4f', 'uniform1ui', 'uniform1fv', 'uniform2fv', 'uniform3fv', 'uniform4fv', 'uniform2i']) {
    handlers[name] = (location, ...values) => {
      if (!location || !program) return;
      const flat = values.flatMap((value) => (typeof value === 'number' ? [value] : Array.from(value)));
      program.uniforms[location.name] = flat.length === 1 ? flat[0] : flat;
      options.onUniform?.(program, location.name, flat);
    };
  }

  const gl = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'canvas') return canvas;
      if (prop === 'drawingBufferWidth') return canvas.width;
      if (prop === 'drawingBufferHeight') return canvas.height;
      if (prop === 'isContextLost') return () => lost;
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return constant(prop);
      return (...args) => {
        log.calls[prop] = (log.calls[prop] ?? 0) + 1;
        if (lost) return prop.startsWith('create') || prop.startsWith('get') ? null : undefined;
        for (const arg of args) touch(arg);
        if (program) touch(program);
        const handler = handlers[prop];
        return handler ? handler(...args) : undefined;
      };
    },
  });

  return {
    gl,
    log,
    /** The context goes away; the event is cancelable, as in a browser. */
    lose() {
      lost = true;
      const event = new Event('webglcontextlost', { cancelable: true });
      canvas.dispatchEvent(event);
      return event;
    },
    /**
     * The browser hands the (same) context back, with nothing in it and a
     * default-sized drawing buffer, so something rebuilt on it that forgets to
     * apply its size again shows up.
     */
    restore() {
      lost = false;
      generation++;
      program = null;
      fbo = null;
      bound.length = 0;
      canvas.width = 300;
      canvas.height = 150;
      canvas.dispatchEvent(new Event('webglcontextrestored'));
    },
    isLost: () => lost,
    /** Programs still alive whose fragment source contains `text`. */
    find(text, { alive = true } = {}) {
      return log.programs.filter((candidate) => (!alive || !candidate.deleted)
        && candidate.shaders.some((shader) => shader.source?.includes(text)));
    },
    draws(prog) {
      return log.draws.filter((draw) => draw.program === prog);
    },
  };
}

/** Stand-ins for the browser globals the renderers reach for. */
export function installFakeDom(probeOptions = {}) {
  const probes = [];
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return {};
      const canvas = new FakeCanvas(probeOptions);
      probes.push(canvas);
      return canvas;
    },
  };
  globalThis.window = Object.assign(new EventTarget(), {
    localStorage: { getItem: () => null, setItem() {} },
    devicePixelRatio: 1,
  });
  return probes;
}
