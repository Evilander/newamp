// The wheel-to-volume mapping: one notch of a mouse wheel is one small step, a
// trackpad flick made of many small events adds up to about the same, and a
// burst of oversized events (macOS acceleration, a stalled renderer) cannot
// run the volume away. Also covers the 100% detent and the input log.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../src/lib/wheel-volume.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const {
  WheelVolumeInput,
  WheelInputLog,
  clampVolume,
  handleVolumeWheel,
  wheelInputLog,
  GESTURE_GAP_MS,
  GESTURE_BUDGET,
  GESTURE_BUDGET_PER_S,
  DETENT_MS,
  WHEEL_LOG_CAPACITY,
} = await import(`data:text/javascript,${encodeURIComponent(code)}`);

const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);

const notch = (deltaY, extra = {}) => ({ deltaY, deltaMode: 0, ...extra });
const fresh = () => new WheelVolumeInput(new WheelInputLog());
// Feeds `events` ([time, event]) through one input, the way the live volume
// is read back before each one. Returns the volume after each event.
const run = (input, start, events) => {
  let volume = start;
  return events.map(([at, event]) => (volume = input.next(event, volume, at).volume));
};
const budgetAt = (elapsedMs) => GESTURE_BUDGET + (GESTURE_BUDGET_PER_S * elapsedMs) / 1000;

// A notched mouse: Chromium reports one click as 100 px.
near(fresh().next(notch(100), 0.5, 1000).volume, 0.46, 'one notch down');
near(fresh().next(notch(-100), 0.5, 1000).volume, 0.54, 'one notch up');
near(fresh().next(notch(-100, { shiftKey: true }), 0.5, 1000).volume, 0.62, 'shift triples a notch');

// Line and page modes are converted to pixels first.
near(fresh().next({ deltaY: -5, deltaMode: 1 }, 0.5, 1000).volume, 0.532, 'five lines');
near(fresh().next({ deltaY: 1, deltaMode: 2 }, 0.9, 1000).volume, 0.58, 'one page down');

// A trackpad flick: 25 events of 6 px, a frame apart. The only departure
// from "by distance" is the first step of the gesture (see below), so the
// whole flick is a nudge, not a jump.
{
  const at = (i) => 1000 + i * 16;
  const out = run(fresh(), 0.5, Array.from({ length: 25 }, (_, i) => [at(i), notch(-6)]));
  const gained = out[24] - 0.5;
  near(gained, 0.02 + 24 * 0.0024, 'a flick adds up by distance after its first step');
  assert.ok(gained < 0.1, `a flick must not jump the volume, got ${gained}`);
}

// A slow click on a Mac can be a few pixels. The first event after a pause
// always moves a whole step so the wheel never seems to have stopped.
{
  const input = fresh();
  let volume = 0.5;
  for (let i = 0; i < 5; i++) {
    const next = input.next(notch(-4), volume, 1000 + i * 500).volume;
    near(next - volume, 0.02, `slow click ${i + 1} up`);
    volume = next;
  }
  for (let i = 0; i < 5; i++) {
    const next = input.next(notch(4), volume, 10000 + i * 500).volume;
    near(volume - next, 0.02, `slow click ${i + 1} down`);
    volume = next;
  }
  // Clicks 150 ms apart are still clicks, even inside one gesture.
  const quick = fresh();
  const out = run(quick, 0.5, [0, 1, 2, 3].map((i) => [2000 + i * 150, notch(-3)]));
  near(out[3] - 0.5, 4 * 0.02, 'clicks 150 ms apart each move a step');
  // A stream of tiny events stays proportional, and sub-pixel jitter is noise.
  const stream = run(fresh(), 0.5, [[1000, notch(-100)], [1016, notch(-4)], [1032, notch(-4)]]);
  near(stream[2] - stream[0], 0.0032, 'tiny events inside a stream stay proportional');
  near(fresh().next(notch(-0.4), 0.5, 1000).volume, 0.5 + 0.00016, 'sub-pixel jitter is not rounded up');
}

// A burst of oversized events in one gesture cannot run away: the gesture
// has a budget, however large each event is.
{
  for (const sign of [-1, 1]) {
    const input = fresh();
    const start = 1;
    let volume = start;
    let maxAway = 0;
    for (let i = 0; i < 10; i++) {
      const at = 1000 + i * 8;
      volume = input.next(notch(sign * 5000, { shiftKey: false }), volume, at).volume;
      maxAway = Math.max(maxAway, Math.abs(volume - start));
      assert.ok(maxAway <= budgetAt(at - 1000) + 1e-9, `event ${i + 1} stays inside the gesture budget`);
    }
    assert.ok(maxAway > 0.3, `the burst still moves the volume, got ${maxAway}`);
  }
  // After a pause a new gesture gets a fresh budget.
  const input = fresh();
  let volume = 1.9;
  for (let i = 0; i < 5; i++) volume = input.next(notch(5000), volume, 1000 + i * 8).volume;
  const afterFirst = volume;
  assert.ok(1.9 - afterFirst <= budgetAt(32) + 1e-9, 'the first gesture stays inside its budget');
  for (let i = 0; i < 5; i++) volume = input.next(notch(5000), volume, 1000 + GESTURE_GAP_MS + 100 + i * 8).volume;
  assert.ok(afterFirst - volume > 0.3, 'the next gesture can move again');
  // A long deliberate roll is never stuck: 20 clicks a second for 2 s is 1.6.
  const roll = run(
    fresh(),
    2,
    Array.from({ length: 40 }, (_, i) => [1000 + i * 50, notch(100)]),
  );
  near(roll[39], 2 - 40 * 0.04, 'a long roll keeps moving');
  // Shift scales the budget with the step.
  const shifted = run(
    fresh(),
    0,
    Array.from({ length: 10 }, (_, i) => [1000 + i * 8, notch(-5000, { shiftKey: true })]),
  );
  assert.ok(shifted[9] <= 3 * budgetAt(72) + 1e-9, 'a shift burst stays inside its scaled budget');
  // The budget is spent in plain-notch units. A Shift run that moved more than
  // a plain gesture could (1.2 here) leaves the notches after it their share.
  for (const sign of [-1, 1]) {
    const log = new WheelInputLog();
    const input = new WheelVolumeInput(log);
    let volume = 0.1;
    for (let i = 0; i < 10; i++) {
      volume = input.next(notch(-100, { shiftKey: true }), volume, 1000 + i * 45).volume;
    }
    near(volume, 1.3, 'ten Shift notches in 450 ms');
    assert.ok(volume - 0.1 > budgetAt(450), 'the Shift run moved more than a plain gesture may');
    for (let i = 0; i < 3; i++) {
      const next = input.next(notch(sign * 100), volume, 1455 + i * 50).volume;
      near(next - volume, -sign * 0.04, `plain notch ${i + 1} after the Shift run, ${sign < 0 ? 'up' : 'down'}`);
      volume = next;
    }
    assert.deepEqual(
      log.entries().slice(10).map((e) => e.outcome),
      ['moved', 'moved', 'moved'],
      'none of them is cut by the budget',
    );
  }
  // Plain movement counts toward the budget at full weight, whatever follows.
  {
    const input = fresh();
    let volume = 0.2;
    for (let i = 0; i < 5; i++) volume = input.next(notch(-5000), volume, 1000 + i * 8).volume;
    const spentPlain = volume - 0.2;
    const shiftNow = input.next(notch(-5000, { shiftKey: true }), volume, 1048);
    assert.ok(
      shiftNow.volume - volume <= (budgetAt(48) - spentPlain) * 3 + 1e-9,
      'a Shift event after plain movement only gets what is left of the budget',
    );
  }
}

// A busy renderer makes Chromium merge queued events into one that carries
// their summed distance and the timestamp of the last. Merged after a stall it
// keeps its distance...
{
  const input = fresh();
  near(input.next(notch(-100), 0.2, 1000).volume, 0.24, 'first event of the gesture');
  near(input.next(notch(-600), 0.24, 1200).volume, 0.48, 'a merged event after a 200 ms stall keeps its distance');
  // ...and a stall long enough to end the gesture still keeps a whole flick.
  near(fresh().next(notch(-600), 0.2, 5000).volume, 0.44, 'a merged flick after a long stall');
  near(fresh().next(notch(-1200), 0.2, 5000).volume, 0.6, 'ten notches in one event is the most');
  near(fresh().next(notch(-12000), 0.2, 5000).volume, 0.6, 'an absurd single delta is capped');
  // The same distance arriving in a frame's time is a burst, not a stall.
  const quick = fresh();
  quick.next(notch(-100), 0.2, 1000);
  near(quick.next(notch(-600), 0.24, 1008).volume, 0.24 + 0.08, 'oversized after a short gap is cut to what the time allows');
}

// 100% is a detent: the wheel stops there, then pauses before it goes on.
{
  const input = fresh();
  const out = run(input, 0.9, [
    [1000, notch(-100)],
    [1100, notch(-100)],
    [1200, notch(-100)], // 0.98 + 0.04 crosses 1.0
    [1300, notch(-100)], // absorbed
    [1400, notch(-100)], // absorbed, and extends the pause
    [1700, notch(-100)], // 300 ms later: still absorbed
  ]);
  near(out[0], 0.94, 'toward 100%');
  near(out[1], 0.98, 'closer');
  near(out[2], 1, 'stops at exactly 100%');
  near(out[3], 1, 'more upward input is absorbed');
  near(out[4], 1, 'and again');
  near(out[5], 1, 'a steady roll never gets through');
  const after = input.next(notch(-100), 1, 1700 + DETENT_MS + 50);
  near(after.volume, 1.04, 'after a pause the wheel goes on into the boost');
  assert.equal(after.outcome, 'moved');
  // Going down through 100% does not stop.
  near(fresh().next(notch(100), 1.02, 1000).volume, 0.98, 'down through 100% does not stop');
  // Shift goes through, from below and from the detent.
  near(fresh().next(notch(-100, { shiftKey: true }), 0.98, 1000).volume, 1.1, 'shift crosses 100%');
  const held = fresh();
  run(held, 0.98, [[1000, notch(-100)]]);
  near(held.next(notch(-100, { shiftKey: true }), 1, 1050).volume, 1.12, 'shift leaves the detent');
  // Sitting at exactly 100% with no stop before it (a double-click reset) is free to go.
  near(fresh().next(notch(-100), 1, 1000).volume, 1.04, 'from a reset 100% the wheel goes up');
  // Coming back down and up again stops again.
  const again = fresh();
  const trip = run(again, 0.96, [
    [1000, notch(-100)],
    [1100, notch(100)],
    [1200, notch(-100)],
    [1300, notch(-100)],
  ]);
  near(trip[0], 1, 'first stop');
  near(trip[1], 0.96, 'back down');
  near(trip[2], 1, 'stops again on the way up');
  near(trip[3], 1, 'and holds');
}

// Horizontal movement counts with Shift (macOS turns Shift+wheel sideways) or
// once a gesture is plainly horizontal; drift inside a vertical swipe doesn't.
{
  near(fresh().next({ deltaY: 0, deltaX: -100, deltaMode: 0, shiftKey: true }, 0.5, 1000).volume, 0.62, 'Shift+wheel up on a Mac');
  near(fresh().next({ deltaY: 0, deltaX: 100, deltaMode: 0 }, 0.5, 1000).volume, 0.54, 'a swipe to the right');
  near(fresh().next({ deltaY: 0, deltaX: -100, deltaMode: 0 }, 0.5, 1000).volume, 0.46, 'a swipe to the left');
  near(fresh().next({ deltaY: -100, deltaX: 30, deltaMode: 0 }, 0.5, 1000).volume, 0.54, 'a diagonal swipe follows the vertical part');
  // A swipe of dy 30 that drifts dx 3 with no vertical part in between never moves the other way.
  const input = fresh();
  let volume = 0.5;
  const swipe = [
    [1000, { deltaY: -30, deltaX: 0 }],
    [1016, { deltaY: 0, deltaX: 3 }],
    [1032, { deltaY: -30, deltaX: 2 }],
    [1048, { deltaY: 0, deltaX: -3 }],
    [1064, { deltaY: -30, deltaX: 0 }],
  ];
  for (const [at, event] of swipe) {
    const step = input.next({ ...event, deltaMode: 0 }, volume, at);
    assert.ok(step.volume >= volume, `drift at ${at} must not move the volume down`);
    if (event.deltaY === 0) {
      assert.equal(step.volume, volume, 'a drift event on its own moves nothing');
      assert.equal(step.outcome, 'ignored-axis');
    }
    volume = step.volume;
  }
  // Shift+wheel on a Mac arrives as deltaX. Letting go of Shift inside the
  // same gesture must not turn it into a sideways swipe that eats the next
  // plain notch.
  const released = fresh();
  const rolled = run(released, 0.2, [
    [1000, { deltaY: 0, deltaX: -100, deltaMode: 0, shiftKey: true }],
    [1050, { deltaY: 0, deltaX: -100, deltaMode: 0, shiftKey: true }],
    [1100, { deltaY: 0, deltaX: -100, deltaMode: 0, shiftKey: true }],
    [1150, notch(-100)],
    [1200, notch(-100)],
  ]);
  near(rolled[2], 0.2 + 3 * 0.12, 'three Shift notches');
  near(rolled[3] - rolled[2], 0.04, 'the first plain notch after Shift moves a notch');
  near(rolled[4] - rolled[3], 0.04, 'and so does the next');
  const afterShift = new WheelInputLog();
  const watched = new WheelVolumeInput(afterShift);
  watched.next({ deltaY: 0, deltaX: -100, deltaMode: 0, shiftKey: true }, 0.2, 1000);
  watched.next(notch(-100), 0.32, 1050);
  assert.equal(afterShift.entries()[1].outcome, 'moved', 'not logged as an ignored axis');
  // A real sideways swipe still counts as one once Shift isn't involved.
  const swipe2 = run(fresh(), 0.5, [
    [1000, { deltaY: 0, deltaX: 100, deltaMode: 0 }],
    [1050, { deltaY: 0, deltaX: 100, deltaMode: 0 }],
  ]);
  near(swipe2[1], 0.58, 'a plain sideways swipe is unchanged');
  // Pure drift as the first event of a gesture is not a click either.
  const drift = fresh().next({ deltaY: 0, deltaX: 3, deltaMode: 0 }, 0.5, 1000);
  assert.equal(drift.volume, 0.5, 'a lone sideways drift moves nothing');
}

// Events that are not a volume gesture.
{
  const input = fresh();
  assert.equal(input.next({ deltaY: Number.NaN, deltaMode: 0 }, 0.5, 1000).volume, 0.5, 'NaN moves nothing');
  const zero = input.next({ deltaY: 0, deltaX: 0, deltaMode: 0 }, 0.5, 1100);
  assert.equal(zero.volume, 0.5);
  assert.equal(zero.outcome, 'ignored-zero');
  // A pinch arrives as ctrl+wheel.
  const pinch = input.next(notch(-80, { ctrlKey: true }), 0.5, 1200);
  assert.equal(pinch.volume, 0.5, 'a pinch does not change the volume');
  assert.equal(pinch.outcome, 'ignored-ctrl');
  // The ends of the range.
  const top = fresh().next(notch(-100), 2, 1000);
  assert.equal(top.volume, 2);
  assert.equal(top.outcome, 'bounds');
  assert.equal(fresh().next(notch(100), 0, 1000).volume, 0, 'the bottom holds');
  assert.equal(clampVolume(2.5), 2);
  assert.equal(clampVolume(-1), 0);
}

// The base is whatever the volume is when the event arrives, so something
// else moving it between two events is respected, not overwritten.
{
  const input = fresh();
  near(input.next(notch(-100), 0.5, 1000).volume, 0.54, 'wheel');
  near(input.next(notch(-100), 0.9, 1100).volume, 0.94, 'built on the volume another control just set');
  near(input.next(notch(100), 0.3, 1200).volume, 0.26, 'and again after a keyboard change');
}

// The log: a ring of the last events with what each did.
{
  const log = new WheelInputLog();
  const input = new WheelVolumeInput(log);
  let volume = 0.4;
  for (let i = 0; i < 250; i++) {
    volume = input.next(
      { deltaY: -6, deltaX: 1, deltaMode: 0, shiftKey: false, wheelDeltaY: 3 },
      volume,
      1000 + i * 16,
      { source: i % 2 ? 'knob' : 'slider', lagMs: i },
    ).volume;
  }
  assert.equal(WHEEL_LOG_CAPACITY, 200);
  assert.equal(log.totalRecorded, 250);
  const entries = log.entries();
  assert.equal(entries.length, 200, 'the ring keeps 200');
  assert.equal(entries[0].lagMs, 50, 'the oldest 50 were dropped');
  assert.equal(entries[199].lagMs, 249);
  const sample = entries[1];
  for (const key of [
    'at', 'source', 'deltaY', 'deltaX', 'deltaMode', 'wheelDeltaY', 'shiftKey', 'ctrlKey', 'msSincePrev',
    'lagMs', 'gesture', 'newGesture', 'before', 'after', 'gestureMoved', 'outcome', 'longTasks', 'longTaskMs',
  ]) {
    assert.ok(key in sample, `a sample carries ${key}`);
  }
  assert.equal(sample.deltaY, -6);
  assert.equal(sample.deltaX, 1);
  assert.equal(sample.wheelDeltaY, 3);
  near(sample.msSincePrev, 16, 'time since the previous event');
  assert.equal(sample.source, 'knob');
  assert.equal(sample.newGesture, false);
  assert.ok(sample.after > sample.before, 'it records the volume before and after');
  assert.equal(entries[0].gesture, entries[199].gesture, 'one stream is one gesture');
  assert.equal(log.entries().length, 200, 'reading does not consume');

  // Gestures are numbered and the first event of each is marked.
  const marks = new WheelInputLog();
  const gestures = new WheelVolumeInput(marks);
  gestures.next(notch(-100), 0.5, 1000);
  gestures.next(notch(-100), 0.5, 1050);
  gestures.next(notch(-100), 0.5, 1050 + GESTURE_GAP_MS + 1);
  const seen = marks.entries();
  assert.deepEqual(seen.map((e) => e.newGesture), [true, false, true]);
  assert.deepEqual(seen.map((e) => e.gesture), [1, 1, 2]);

  // Long tasks are counted against the events they delayed.
  const tasks = new WheelInputLog();
  const timed = new WheelVolumeInput(tasks);
  timed.next(notch(-100), 0.5, 1000);
  tasks.noteLongTask(1010, 120);
  tasks.noteLongTask(1150, 70);
  timed.next(notch(-100), 0.5, 1300);
  timed.next(notch(-100), 0.5, 1316);
  const [first, second, third] = tasks.entries();
  assert.equal(first.longTasks, 0);
  assert.equal(second.longTasks, 2, 'two long tasks ran before the second event');
  near(second.longTaskMs, 190, 'their total');
  assert.equal(third.longTasks, 0, 'and none before the third');

  // A task that started after the input arrived but before the handler ran is
  // the one that delayed the event, so it is counted against that event.
  const delayed = new WheelInputLog();
  const lagging = new WheelVolumeInput(delayed);
  lagging.next(notch(-100), 0.5, 1000, { lagMs: 160 });
  delayed.noteLongTask(1005, 150);
  delayed.noteLongTask(1200, 90);
  const [held] = delayed.entries();
  assert.equal(held.longTasks, 1, 'the task that ran while the event waited counts');
  near(held.longTaskMs, 150, 'and only that one: the other started after the handler');

  const text = tasks.format({ app: 'NewAmp v9.9.9 / Electron 42', userAgent: 'Mozilla/5.0 (Macintosh) test' });
  assert.match(text, /^NewAmp wheel input log/);
  assert.match(text, /app: NewAmp v9\.9\.9 \/ Electron 42/);
  assert.match(text, /userAgent: Mozilla\/5\.0 \(Macintosh\) test/);
  assert.match(text, /samples: 3 of 3 recorded/);
  assert.match(text, /long tasks: 2 totalling 190 ms/);
  const rows = text.split('\n').filter((line) => line.startsWith('{'));
  assert.equal(rows.length, 3);
  assert.equal(JSON.parse(rows[1]).longTasks, 2, 'the copied rows are JSON, one per event');
}

// The shared handler: reads the live volume, owns the wheel, writes only on a change.
{
  let volume = 0.5;
  const writes = [];
  const access = {
    read: () => volume,
    write: (value) => {
      writes.push(value);
      volume = value;
    },
  };
  let prevented = 0;
  const event = (deltaY, timeStamp, extra = {}) => ({
    deltaY,
    deltaX: 0,
    deltaMode: 0,
    timeStamp,
    preventDefault: () => {
      prevented += 1;
    },
    ...extra,
  });
  const before = wheelInputLog.totalRecorded;
  handleVolumeWheel(event(-100, 100000), 'slider', access);
  near(volume, 0.54, 'the handler applies the step');
  // Another control moves the volume before the next event: the handler sees it.
  volume = 0.9;
  handleVolumeWheel(event(-100, 100010), 'slider', access);
  near(volume, 0.94, 'the base is the live volume, not the last one it wrote');
  handleVolumeWheel(event(0, 100020), 'slider', access);
  assert.equal(writes.length, 2, 'an event that changes nothing writes nothing');
  assert.equal(prevented, 3, 'every event over the control is claimed, even a zero one');
  handleVolumeWheel(event(-100, 100030, { ctrlKey: true }), 'knob', access);
  assert.equal(prevented, 3, 'a pinch is left to the browser');
  assert.equal(writes.length, 2);
  assert.equal(wheelInputLog.totalRecorded - before, 4, 'every event is logged');
  const last = wheelInputLog.entries().at(-1);
  assert.equal(last.source, 'knob');
  assert.equal(last.outcome, 'ignored-ctrl');
  assert.ok(typeof last.lagMs === 'number', 'the handler records how late the event ran');
}

console.log('PASS wheel volume: notches step, slow clicks move, bursts are budgeted, 100% pauses, drift is ignored, the log keeps 200');
