export async function sha256Hex(input) {
  const text = typeof input === 'string' ? input : stableStringify(input);
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function stableStringify(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortKeys(value[key]);
      return acc;
    }, {});
  }
  return value;
}

export function liveFingerprint(match) {
  return stableStringify({
    id: match.id,
    status: match.status,
    minute: match.minute,
    h: match.h,
    a: match.a,
    pH: match.pH ?? null,
    pA: match.pA ?? null,
    scorers: match.scorers || [],
    redCards: match.redCards || [],
    yellowCards: match.yellowCards || [],
    doubleYellowCards: match.doubleYellowCards || []
  });
}
