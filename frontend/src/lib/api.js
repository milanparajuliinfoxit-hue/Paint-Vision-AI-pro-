const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
const API_KEY = import.meta.env.VITE_API_ACCESS_KEY || '';

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  return contentType.includes('application/json') ? res.json() : res.blob();
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

// --- Visualizer ---
export const visualizer = {
  upload: (file, projectId) => {
    const form = new FormData();
    form.append('image', file);
    if (projectId) form.append('projectId', projectId);
    return request('/api/visualizer/upload', { method: 'POST', body: form });
  },
  getJob: (jobId) => request(`/api/visualizer/jobs/${jobId}`),
  requestCleanup: (jobId, maskFile) => {
    const form = new FormData();
    if (maskFile) form.append('mask', maskFile);
    return request(`/api/visualizer/jobs/${jobId}/cleanup`, { method: 'POST', body: form });
  },
  saveResult: (jobId, blob, { paintId, surfaceLabel } = {}) => {
    const form = new FormData();
    form.append('result', blob, 'result.png');
    if (paintId) form.append('paintId', paintId);
    if (surfaceLabel) form.append('surfaceLabel', surfaceLabel);
    return request(`/api/visualizer/jobs/${jobId}/results`, { method: 'POST', body: form });
  },
  listResults: (jobId) => request(`/api/visualizer/jobs/${jobId}/results`),
  fileUrl: (relativePath) => `${BASE_URL}/files/${relativePath}`,
};

// --- Projects ---
export const projects = {
  list: () => request('/api/projects'),
  create: (data) => request('/api/projects', { method: 'POST', body: JSON.stringify(data) }),
};
