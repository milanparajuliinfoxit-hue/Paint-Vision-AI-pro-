import { logger } from './logger';

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
const API_KEY = import.meta.env.VITE_API_ACCESS_KEY || '';

// Default timeout for ordinary CRUD calls; AI analysis/recommendations and
// image cleanup run real model inference server-side and need much longer.
const DEFAULT_TIMEOUT_MS = 15000;
const LONG_TIMEOUT_MS = 60000;

async function request(path, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
        ...options.headers,
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn('api.request.timeout', { method: options.method || 'GET', path, timeoutMs });
      const timeoutErr = new Error('Request timed out. Please check your connection and try again.');
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    logger.error('api.request.network_error', { method: options.method || 'GET', path, message: err.message });
    const networkErr = new Error('Network error. Please check your connection and try again.');
    networkErr.isNetworkError = true;
    networkErr.cause = err;
    throw networkErr;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // X-Request-Id (set by the backend's request-correlation middleware)
    // ties this log line back to the exact server-side request/error logs.
    logger.error('api.request.failed', {
      method: options.method || 'GET',
      path,
      status: res.status,
      requestId: res.headers.get('x-request-id') || undefined,
    });
    const err = new Error(body.error || `Request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  return contentType.includes('application/json') ? res.json() : res.blob();
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
  // A plain <a href> to this endpoint can't attach the x-api-key header, so
  // it 401s the moment a real key is configured (which .env already has) —
  // fetch it as a blob through `request` (which does attach the header)
  // instead; the caller turns the blob into a download.
  export: () => request('/api/catalog/import/export'),
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
  setUndoPointer: (id, pointer) =>
    request(`/api/projects/${id}/undo-pointer`, { method: 'PATCH', body: JSON.stringify({ pointer }) }),
  remove: (id) => request(`/api/projects/${id}`, { method: 'DELETE' }),
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
    return request(`/api/assets/${assetId}/clean`, { method: 'POST', body: form }, LONG_TIMEOUT_MS);
  },
  // /files/* is gated by the same access key as /api (see backend app.js) —
  // but this URL is consumed directly by <img src>/Konva Image, which can't
  // attach the x-api-key header, so the key travels as a query param here
  // instead (only here; every other request still uses the header).
  fileUrl: (relativePath) => {
    const path = `${BASE_URL}/files/${String(relativePath).replace(/\\/g, '/')}`;
    return API_KEY ? `${path}?key=${encodeURIComponent(API_KEY)}` : path;
  },
};

// --- Layers (masked, re-colorable surface regions on an asset) ---
export const layers = {
  create: (assetId, { name, createdVia, currentColorId, opacity, orderIndex, aiSurfaceKey, aiAnalysisId, aiSchemeId }, maskBlob) => {
    const form = toForm({ name, createdVia, currentColorId, opacity, orderIndex, aiSurfaceKey, aiAnalysisId, aiSchemeId }, { mask: maskBlob });
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

// --- Meta (feature-flag-aware platform info) ---
export const meta = {
  get: () => request('/api/meta'),
};

// --- AI (house-understanding + catalog-only paint recommendations) ---
export const ai = {
  analyze: (assetId) => request(`/api/assets/${assetId}/ai/analyze`, { method: 'POST' }, LONG_TIMEOUT_MS),
  getAnalysis: (assetId) => request(`/api/assets/${assetId}/ai/analysis`),
  generateRecommendations: (assetId, count) =>
    request(`/api/assets/${assetId}/ai/recommendations`, { method: 'POST', body: JSON.stringify({ count }) }, LONG_TIMEOUT_MS),
  listRecommendations: (assetId) => request(`/api/assets/${assetId}/ai/recommendations`),
  // Autonomous pipeline: process() starts (or no-ops if already running/done);
  // getStatus() is the lightweight, frequently-polled read.
  process: (assetId, { force } = {}) =>
    request(`/api/assets/${assetId}/ai/process`, { method: 'POST', body: JSON.stringify({ force: !!force }) }, LONG_TIMEOUT_MS),
  getStatus: (assetId) => request(`/api/assets/${assetId}/ai/status`),
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
