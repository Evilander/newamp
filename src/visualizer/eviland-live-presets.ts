// Butterchurn 2.6.7's updateShader immediately queries attribute/uniform
// locations after linking. Those queries wait for the compiler. In Eviland
// Live, build the next pair without queries, keep drawing the old preset, and
// adopt the completed pair when loadPreset swaps its two shader slots.
// No second visualizer/context, framebuffer or catalog-sized program cache.

interface PresetShader {
  gl: WebGL2RenderingContext;
  shaderProgram: WebGLProgram;
  createShader(text: string): void;
  updateShader(text: string): void;
}
interface Host {
  gl: WebGL2RenderingContext;
  warpShader: PresetShader;
  prevWarpShader: PresetShader;
  compShader: PresetShader;
  prevCompShader: PresetShader;
}
interface Visualizer {
  renderer: Host;
  loadPreset(preset: Record<string, unknown>, blend: number): void;
}

export interface LivePresetLoader {
  request(preset: Record<string, unknown>, key: string, blend: number): void;
  /** Poll once per painted frame. The old preset stays live while compiling. */
  advance(): boolean;
  dispose(): void;
}

interface ShaderJob {
  text: string;
  program: WebGLProgram;
  patch: Record<string, unknown>;
  resolve(): void;
  adopted: boolean;
}

export function createLivePresetLoader(value: unknown, onLoadError?: () => void): LivePresetLoader | null {
  const visualizer = value as Visualizer | null;
  const host = visualizer?.renderer;
  if (!host?.gl || !visualizer || typeof visualizer.loadPreset !== 'function') return null;
  const slots = [host.warpShader, host.prevWarpShader, host.compShader, host.prevCompShader];
  if (slots.some(slot => !slot || typeof slot.createShader !== 'function' || typeof slot.updateShader !== 'function')) return null;
  const gl = host.gl;
  const parallel = gl.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null;
  let disposed = false;
  let lastKey: string | null = null;
  let pending: { preset: Record<string, unknown>; blend: number; jobs: ShaderJob[]; frames: number } | null = null;
  let promoting: ShaderJob[] | null = null;

  function discard(jobs: ShaderJob[]): void {
    for (const job of jobs) if (!job.adopted) gl.deleteProgram(job.program);
  }

  function compile(slot: PresetShader, text: string): ShaderJob {
    const programs: WebGLProgram[] = [];
    const shaders: WebGLShader[] = [];
    const locations = new Map<object, () => WebGLUniformLocation | number | null>();
    const location = (query: () => WebGLUniformLocation | number | null): object => {
      const token = {};
      locations.set(token, query);
      return token;
    };
    // createShader only writes shaderProgram, locations and a fresh userTextures
    // array. Inherit the slot's precision and helpers without touching its live
    // program, geometry buffers, samplers, textures or resolution.
    const draft = Object.create(slot) as PresetShader & Record<string, unknown>;
    draft.gl = {
      VERTEX_SHADER: gl.VERTEX_SHADER,
      FRAGMENT_SHADER: gl.FRAGMENT_SHADER,
      createProgram() {
        const p = gl.createProgram();
        if (!p) throw new Error('program allocation failed');
        programs.push(p); return p;
      },
      createShader(kind: number) {
        const shader = gl.createShader(kind);
        if (!shader) throw new Error('shader allocation failed');
        shaders.push(shader); return shader;
      },
      shaderSource: gl.shaderSource.bind(gl),
      compileShader: gl.compileShader.bind(gl),
      attachShader: gl.attachShader.bind(gl),
      linkProgram: gl.linkProgram.bind(gl),
      getUniformLocation: (p: WebGLProgram, name: string) => location(() => gl.getUniformLocation(p, name)),
      getAttribLocation: (p: WebGLProgram, name: string) => location(() => gl.getAttribLocation(p, name)),
    } as unknown as WebGL2RenderingContext;
    try {
      slot.createShader.call(draft, text);
      if (programs.length !== 1) throw new Error('unexpected Butterchurn shader layout');
      const patch: Record<string, unknown> = { ...draft };
      delete patch.gl;
      return {
        text, program: programs[0]!, patch, adopted: false,
        resolve() {
          const resolved = new Map<object, WebGLUniformLocation | number | null>();
          for (const [token, query] of locations) resolved.set(token, query());
          for (const [key, v] of Object.entries(patch)) {
            if (resolved.has(v as object)) patch[key] = resolved.get(v as object);
          }
          const textures = patch.userTextures as Array<{ textureLoc: unknown }> | undefined;
          for (const texture of textures ?? []) {
            if (resolved.has(texture.textureLoc as object)) texture.textureLoc = resolved.get(texture.textureLoc as object);
          }
          locations.clear();
        },
      };
    } catch (error) {
      for (const program of programs) gl.deleteProgram(program);
      throw error;
    } finally {
      // Deletion is deferred by GL until the linked program no longer needs
      // these shaders; no shader handles accumulate across preset changes.
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  const originals = slots.map(slot => slot.updateShader);
  slots.forEach((slot, index) => {
    // Butterchurn does not delete the shaders attached to its initial programs.
    for (const shader of gl.getAttachedShaders(slot.shaderProgram) ?? []) gl.deleteShader(shader);
    slot.updateShader = function (text) {
      const job = promoting?.[index < 2 ? 0 : 1];
      const old = this.shaderProgram;
      if (job && job.text === text) {
        Object.assign(this, job.patch);
        job.adopted = true;
      } else {
        originals[index]!.call(this, text);
        for (const shader of gl.getAttachedShaders(this.shaderProgram) ?? []) gl.deleteShader(shader);
      }
      if (old !== this.shaderProgram) gl.deleteProgram(old);
    };
  });

  return {
    request(preset, key, blend) {
      if (disposed || key === lastKey) return;
      lastKey = key;
      if (pending) discard(pending.jobs);
      pending = null;
      const jobs: ShaderJob[] = [];
      try {
        jobs.push(compile(host.warpShader, String(preset.warp ?? '').trim()));
        jobs.push(compile(host.compShader, String(preset.comp ?? '').trim()));
        pending = { preset, blend, jobs, frames: 0 };
      } catch (error) {
        discard(jobs);
        console.warn('[eviland] could not prepare Live preset:', error);
      }
    },
    advance() {
      if (disposed || !pending || gl.isContextLost()) return false;
      pending.frames++;
      // Drivers without parallel compilation have no non-blocking completion
      // signal. Give their compiler several paints before querying the link.
      if (parallel ? pending.jobs.some(job => !gl.getProgramParameter(job.program, parallel.COMPLETION_STATUS_KHR)) : pending.frames < 4) return false;
      const next = pending;
      pending = null;
      try {
        for (const job of next.jobs) {
          if (!gl.getProgramParameter(job.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(job.program) ?? 'preset shader failed');
          job.resolve();
        }
        promoting = next.jobs;
        visualizer.loadPreset(next.preset, next.blend);
        return true;
      } catch (error) {
        console.warn('[eviland] Live preset switch failed:', error);
        // loadPreset mutates the host before running preset equations. If
        // those throw, let the host replace the partially loaded preset.
        // Shader/link failures happen earlier and simply keep the old look.
        const loadStarted = promoting !== null;
        promoting = null;
        if (loadStarted) onLoadError?.();
        return false;
      } finally {
        promoting = null;
        discard(next.jobs);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pending) discard(pending.jobs);
      pending = null;
      slots.forEach((slot, i) => { slot.updateShader = originals[i]!; });
    },
  };
}
