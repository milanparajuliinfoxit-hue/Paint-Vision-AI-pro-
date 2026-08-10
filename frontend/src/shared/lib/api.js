const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
const API_KEY = import.meta.env.VITE_API_ACCESS_KEY || '';

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
        ...options.headers,
      },
    });
  } catch (cause) {
    // fetch only rejects for transport failures, and the browser's message
    // ("Failed to fetch") says nothing about which server is unreachable.
    const err = new Error(`Cannot reach the server at ${BASE_URL}. Check that the backend is running.`);
    err.isNetworkError = true;
    err.cause = cause;
    throw err;
  }

  if (!res.ok) throw await toHttpError(res);

  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return res.blob();

  try {
    return await res.json();
  } catch (cause) {
    // A 200 whose body isn't the JSON it claims to be (truncated response,
    // a proxy's HTML error page) is a real failure — don't hand callers
    // `undefined` and let it surface as a confusing render error later.
    const err = new Error(`Malformed JSON response from ${path}`);
    err.status = res.status;
    err.cause = cause;
    throw err;
  }
}

// Error responses aren't always the JSON envelope the API promises — a proxy
// timeout or a crash upstream returns HTML/plain text. Reading as text first
// keeps that detail in the message instead of collapsing every one of them
// into a bare status code.
async function toHttpError(res) {
  const raw = await res.text().catch(() => '');
  let message = '';
  try {
    message = JSON.parse(raw).error || '';
  } catch {
    message = raw.trim().slice(0, 200);
  }
  const err = new Error(message || `Request failed: ${res.status} ${res.statusText}`.trim());
  err.status = res.status;
  return err;
}

function toForm(fields = {}, fileEntries = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === 'object' ? JSON.stringify(value) : value);
  }
  for (const [key, file] of Object.entries(fileEntries)) {
    if (file) form.append(key, file);
  }
  return form;
}

// --- Catalog ---
export const catalog = {
  list: (params = {}) => request(`/api/catalog?${new URLSearchParams(params)}`),
  get: (id) => request(`/api/catalog/${id}`),
  create: (data) => request('/api/catalog', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => request(`/api/catalog/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id) => request(`/api/catalog/${id}`, { method: 'DELETE' }),
  previewImport: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('/api/catalog/import/preview', { method: 'POST', body: form });
  },
  commitImport: (payload) => request('/api/catalog/import/commit', { method: 'POST', body: JSON.stringify(payload) }),
  exportUrl: () => `${BASE_URL}/api/catalog/import/export`,
};

// --- Projects ---
// The Visualizer only ever opens in the context of a project (requirements
// doc, Section 3) — everything below (assets/layers/history/concepts/
// exports) hangs off a project id.
export const projects = {
  list: (params = {}) => request(`/api/projects?${new URLSearchParams(params)}`),
  get: (id) => request(`/api/projects/${id}`),
  create: (data) => request('/api/projects', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, patch, updatedAt) =>
    request(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ ...patch, updatedAt }) }),
};

// --- Assets (uploaded photos + their AI-cleaned derivative) ---
export const assets = {
  upload: (projectId, file) => {
    const form = new FormData();
    form.append('image', file);
    return request(`/api/projects/${projectId}/assets`, { method: 'POST', body: form });
  },
  list: (projectId) => request(`/api/projects/${projectId}/assets`),
  get: (assetId) => request(`/api/assets/${assetId}`),
  rename: (assetId, label) => request(`/api/assets/${assetId}`, { method: 'PATCH', body: JSON.stringify({ label }) }),
  remove: (assetId) => request(`/api/assets/${assetId}`, { method: 'DELETE' }),
  duplicate: (assetId) => request(`/api/assets/${assetId}/duplicate`, { method: 'POST' }),
  clean: (assetId, maskBlob) => {
    const form = new FormData();
    if (maskBlob) form.append('mask', maskBlob);
    return request(`/api/assets/${assetId}/clean`, { method: 'POST', body: form });
  },
  fileUrl: (relativePath) => `${BASE_URL}/files/${String(relativePath).replace(/\\/g, '/')}`,
};

// --- Layers (masked, re-colorable surface regions on an asset) ---
export const layers = {
  create: (assetId, { name, createdVia, currentColorId, opacity, orderIndex }, maskBlob) => {
    const form = toForm({ name, createdVia, currentColorId, opacity, orderIndex }, { mask: maskBlob });
    return request(`/api/assets/${assetId}/layers`, { method: 'POST', body: form });
  },
  list: (assetId) => request(`/api/assets/${assetId}/layers`),
  // maskBlob is only present for mask-edit-mode brush updates — those go
  // multipart; everything else (color/opacity/order/etc.) stays plain JSON.
  update: (layerId, patch, updatedAt, maskBlob) => {
    if (maskBlob) {
      const form = toForm({ ...patch, updatedAt }, { mask: maskBlob });
      return request(`/api/layers/${layerId}`, { method: 'PATCH', body: form });
    }
    return request(`/api/layers/${layerId}`, { method: 'PATCH', body: JSON.stringify({ ...patch, updatedAt }) });
  },
  remove: (layerId) => request(`/api/layers/${layerId}`, { method: 'DELETE' }),
  restore: (layerId) => request(`/api/layers/${layerId}/restore`, { method: 'POST' }),
};

// --- History (append-only undo/redo log, persisted per project) ---
export const history = {
  append: (projectId, entry) =>
    request(`/api/projects/${projectId}/history`, { method: 'POST', body: JSON.stringify(entry) }),
  list: (projectId) => request(`/api/projects/${projectId}/history`),
};

// --- Concepts (named saved "looks") ---
export const concepts = {
  create: (projectId, { name, layerColorMap }, thumbnailBlob) => {
    const form = toForm({ name, layerColorMap }, { thumbnail: thumbnailBlob });
    return request(`/api/projects/${projectId}/concepts`, { method: 'POST', body: form });
  },
  list: (projectId) => request(`/api/projects/${projectId}/concepts`),
};

// --- Exports (client-rendered PNG/side-by-side-jpg; PDF is deferred server-side) ---
export const exportsApi = {
  create: (projectId, { format, comparisonMode }, fileBlob) => {
    const form = toForm({ format, comparisonMode }, { file: fileBlob });
    return request(`/api/projects/${projectId}/exports`, { method: 'POST', body: form });
  },
  get: (exportId) => request(`/api/exports/${exportId}`),
  list: (projectId) => request(`/api/projects/${projectId}/exports`),
};
