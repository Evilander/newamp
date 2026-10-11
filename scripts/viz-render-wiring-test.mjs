// Wiring in the visualizer sources that no runtime test reaches: the canvases
// stay out of the accessibility tree, the render loops are paced loops rather
// than bare animation-frame loops, and each GPU mode hands its context back.
//
// Read from the TypeScript syntax tree rather than matched as text, so a
// reformat does not break it and a new canvas or loop cannot slip past.
//
// Run: node scripts/viz-render-wiring-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const parse = (file) => ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const walk = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

// ── Decorative canvases are hidden from assistive technology ─────────────────
// The visualizer and the Wrapped preview paint pictures with no content a
// screen reader could read; the Settings QR code is labelled and left alone.
for (const file of ['src/components/Visualizer.tsx', 'src/components/WrappedLiveExport.tsx']) {
  const sf = parse(file);
  let canvases = 0;
  walk(sf, (node) => {
    if (!(ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) || node.tagName.getText(sf) !== 'canvas') return;
    canvases += 1;
    const attribute = node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'aria-hidden');
    assert.ok(attribute, `${file}:${lineOf(sf, node)}: this <canvas> is not aria-hidden`);
    assert.equal(attribute.initializer?.getText(sf).replace(/[{}'"]/g, ''), 'true', `${file}:${lineOf(sf, node)}: aria-hidden is not "true"`);
  });
  assert.ok(canvases > 0, `${file}: no <canvas> found; the check is out of date`);
}

// ── Render loops sleep between paints ───────────────────────────────────────
// A bare requestAnimationFrame loop wakes on every vsync (165 Hz on some
// monitors) to decide not to draw, and a frame request is all it has when the
// compositor stops delivering frames. The only one left is the shader loop's
// opt-out for callers that drive it with their own animation-frame stub.
{
  const file = 'src/components/Visualizer.tsx';
  const sf = parse(file);
  const bare = [];
  walk(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'requestAnimationFrame') {
      let owner = node.parent;
      while (owner && !(ts.isFunctionDeclaration(owner) && owner.name)) owner = owner.parent;
      bare.push(owner?.name.text ?? '(top level)');
    }
  });
  assert.deepEqual([...new Set(bare)], ['startShaderVisualizer'], `bare requestAnimationFrame loops outside the shader opt-out: ${bare.join(', ')}`);
  const optOut = readFileSync(file, 'utf8');
  assert.match(optOut, /paced\?: boolean/, 'the shader loop keeps its paced switch');
  assert.match(optOut, /paced: true,/, 'the component runs the shader loop paced');
}

// ── Every GPU mode hands its context back ───────────────────────────────────
// In the function the component's effect (or the shader starter) returns as
// its cleanup, not somewhere a mode could leave it behind.
{
  const file = 'src/components/Visualizer.tsx';
  const sf = parse(file);
  const releases = [];
  walk(sf, (node) => {
    if (!(ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'releaseGlContext')) return;
    let fn = node.parent;
    while (fn && !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn))) fn = fn.parent;
    releases.push({ line: lineOf(sf, node), inCleanup: Boolean(fn && ts.isReturnStatement(fn.parent)) });
  });
  // Eviland, particle flow, the shader modes and the guarded 2D painters.
  assert.ok(releases.length >= 4, `releaseGlContext is called ${releases.length} times; the GPU modes are Eviland, particle flow, shader and the guarded 2D surface`);
  for (const release of releases) assert.ok(release.inCleanup, `${file}:${release.line}: releaseGlContext is not in a returned cleanup function`);
}

// ── The MilkDrop frame gives its context back and listens for config ────────
{
  const frameFile = 'src/butterchurn-iframe/main.ts';
  const frameSf = parse(frameFile);
  const frame = readFileSync(frameFile, 'utf8');
  let dispose = null;
  walk(frameSf, (node) => {
    if (ts.isIfStatement(node) && /message\.type === 'dispose'/.test(node.expression.getText(frameSf))) dispose = node.thenStatement.getText(frameSf);
  });
  assert.ok(dispose, 'the frame handles a dispose message');
  assert.match(dispose, /WEBGL_lose_context/, 'the frame releases its GL context when it is disposed');
  assert.match(frame, /message\.type === 'config'/, 'the frame applies config messages after init');
  const protocol = readFileSync('src/butterchurn-iframe/protocol.ts', 'utf8');
  assert.match(protocol, /playing\?: boolean/, 'audio messages say whether the track is playing');
  assert.match(protocol, /BcParentMessage = [^;]*BcConfigMessage/, 'config is one of the messages the frame accepts');
  const component = readFileSync('src/components/Visualizer.tsx', 'utf8');
  assert.match(component, /playing: engine\.getState\(\)\.playing/, 'the pump sends the playing state');
  assert.match(component, /sampleRate: feedSampleRate\(/, 'the frame is told the rate of the samples it is fed');

  // The pixel budget reaches the frame, which sizes its own canvas.
  assert.match(component, /dpr,\s*maxPixels,/, 'the init message carries the pixel budget');
  assert.match(frame, /fitCanvasSize\([^;]*hostConfig\.maxPixels/, 'the frame sizes its canvas within the pixel budget');
  // The renderer's band edges follow the rate the frame has been told so far,
  // not the one it was started with.
  assert.match(frame, /const rate = clampRate\(hostConfig\.sampleRate\)/, 'the frame builds its audio context at the current rate');
  // A new display usually refreshes at another rate.
  let onDprChange = null;
  walk(frameSf, (node) => {
    if (ts.isIfStatement(node) && node.expression.getText(frameSf) === 'change.dpr' && /measureDisplayRefresh\(true\)/.test(node.thenStatement.getText(frameSf))) onDprChange = node;
  });
  assert.ok(onDprChange, 'the frame measures the display again when the pixel ratio changes');
}

// ── The guarded 2D fallback ──────────────────────────────────────────────────
{
  const file = 'src/components/Visualizer.tsx';
  const sf = parse(file);
  // The fallback can start only once the canvas is there; a call made while it
  // is not must be able to try again.
  let start = null;
  walk(sf, (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(sf) === 'startFallback' && node.initializer && ts.isArrowFunction(node.initializer)) start = node.initializer;
  });
  assert.ok(start && ts.isBlock(start.body), 'startFallback is an arrow function with a block body');
  const statements = start.body.statements.map((st) => st.getText(sf));
  const nullCheck = statements.findIndex((st) => /^if \(!node\) return;?$/.test(st));
  const flag = statements.findIndex((st) => st === 'fallbackStarted = true;');
  assert.ok(nullCheck >= 0 && flag >= 0, 'startFallback checks the canvas and marks itself started');
  assert.ok(nullCheck < flag, 'startFallback marks itself started only once it has a canvas');

  // The lowest bin is the DC offset, which reads as constant energy.
  const fromBinZero = [];
  walk(sf, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'avg' && node.arguments[1]?.getText(sf) === '0') fromBinZero.push(lineOf(sf, node));
  });
  assert.deepEqual(fromBinZero, [], `avg() starts at bin 0 at line(s) ${fromBinZero.join(', ')}`);
}

// ── The loops that run in the 4K budget ─────────────────────────────────────
// The 4K budget is 8.3 Mpx. Eviland and the MilkDrop frame govern their own
// cost; the other GPU modes and the 2D painters get a governor at that tier,
// and the 2D loop books its frames on the shared 30 Hz grid.
{
  const file = 'src/components/Visualizer.tsx';
  const sf = parse(file);
  const governed = [];
  walk(sf, (node) => {
    if (ts.isConditionalExpression(node) && node.condition.getText(sf) === 'fourK' && ts.isCallExpression(node.whenTrue) && node.whenTrue.expression.getText(sf) === 'createGovernor') {
      const owner = node.parent;
      governed.push(ts.isVariableDeclaration(owner) ? owner.name.getText(sf) : ts.isPropertyAssignment(owner) ? `${owner.name.getText(sf)}:` : '?');
    }
  });
  assert.deepEqual(governed.sort(), ['governor:', 'gov', 'gov'].sort(), 'particle flow, the shader modes and the 2D painters get a governor at the 4K tier');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /const fourK = isFullscreen && performance !== 'low' && quality === '4k';/, 'the governed tier is the 4K option');
  assert.match(text, /createFrameGate\(\s*canvasRef,[^;]*AMBIENT_FRAME_MS : undefined/, 'the 2D loop books its frames on the shared grid');
}

console.log('[viz-render-wiring-test] PASS');
