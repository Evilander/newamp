// Independent render state, identical audio, three timestamps, fixed palette,
// spatial and temporal comparisons, and a recolour-only negative control.
process.argv.push('--diversity');
await import('./eviland-visual-test.mjs');
