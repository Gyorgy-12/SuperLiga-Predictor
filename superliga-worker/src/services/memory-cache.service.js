const memory = globalThis.__SUPERLIGA_WORKER_CACHE__ || (globalThis.__SUPERLIGA_WORKER_CACHE__ = {
  liveResults: {},
  finalResults: {},
  hashes: {},
  updatedAt: null,
  expiresAt: 0,
  manualLive: {},
  accessToken: null,
  accessTokenExpiresAt: 0
});

export function getMemory() {
  return memory;
}

export function getLiveSnapshot() {
  return {
    results: { ...memory.finalResults, ...memory.liveResults, ...memory.manualLive },
    updatedAt: memory.updatedAt,
    source: 'memory'
  };
}

export function mergeLiveResults(results = {}, source = 'unknown') {
  let changed = false;
  for (const [id, value] of Object.entries(results)) {
    if (!value) continue;
    const prev = memory.liveResults[id] || memory.manualLive[id];
    const next = { ...value, source: value.source || source, updatedAt: value.updatedAt || new Date().toISOString() };
    if (JSON.stringify(prev || null) !== JSON.stringify(next)) {
      memory.liveResults[id] = next;
      changed = true;
    }
  }
  if (changed) memory.updatedAt = new Date().toISOString();
  return changed;
}

export function setManualLive(results = {}) {
  memory.manualLive = { ...memory.manualLive, ...results };
  memory.updatedAt = new Date().toISOString();
  return memory.manualLive;
}

export function clearManualLive() {
  memory.manualLive = {};
  memory.updatedAt = new Date().toISOString();
}

export function setFinalResult(id, result) {
  memory.finalResults[id] = result;
  delete memory.liveResults[id];
  memory.updatedAt = new Date().toISOString();
}
