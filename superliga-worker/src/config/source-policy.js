export const SOURCE_POLICY = {
  scoreMaster: 'livescore',
  eventMaster: ['sofascore', 'espn', 'manual'],
  // Worker active window. Outside this, /live-results should be cheap and mostly idle.
  syncBeforeMs: 5 * 60 * 1000,
  syncAfterMs: 140 * 60 * 1000,
  livePollMs: 30 * 1000,
  idlePollMs: 30 * 60 * 1000,
  // Final matches are written once or twice, not every polling tick.
  finalConfirmMs: 12 * 60 * 1000
};
