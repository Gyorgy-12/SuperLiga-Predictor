export async function edgeGet(request) {
  try {
    return await caches.default.match(request);
  } catch (_) {
    return null;
  }
}

export async function edgePut(request, response, seconds = 20) {
  try {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', `public, max-age=${Math.max(0, Number(seconds) || 0)}`);
    const cloned = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    await caches.default.put(request, cloned.clone());
    return cloned;
  } catch (_) {
    return response;
  }
}
