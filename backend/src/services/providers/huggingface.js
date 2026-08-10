const { post, ProviderError } = require('./httpClient');

/**
 * Hugging Face Inference Providers provider.
 *
 * NOTE: the legacy serverless endpoint (api-inference.huggingface.co) was
 * decommissioned. HF now routes image tasks through "Inference Providers"
 * at https://router.huggingface.co/<provider>/<provider-model-id> using a
 * single Bearer token (billed to the HF account).
 *
 * Request format and JSON shape are configurable because every provider
 * (fal-ai, replicate, together, …) and model expects a slightly different
 * payload. The response is validated and normalized to a Buffer whether the
 * model returns raw image bytes or a JSON wrapper with a base64 image field.
 */

const IMAGE_MAGIC = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], type: 'PNG' },
  { bytes: [0xff, 0xd8, 0xff], type: 'JPEG' },
  { bytes: [0x47, 0x49, 0x46], type: 'GIF' },
  { bytes: [0x52, 0x49, 0x46, 0x46], type: 'WEBP' },
];

function readConfig() {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new ProviderError('HF_API_KEY is missing (see .env.example)', { provider: 'huggingface' });
  }

  const model = process.env.HF_MODEL;
  if (!model || !model.trim()) {
    throw new ProviderError('HF_MODEL is missing (see .env.example)', { provider: 'huggingface' });
  }

  const url = process.env.HF_API_URL;
  if (!url || !url.trim()) {
    throw new ProviderError('HF_API_URL is missing (see .env.example)', { provider: 'huggingface' });
  }

  return { apiKey: apiKey.trim(), model: model.trim(), url: url.trim() };
}

function buildJsonPayload(imageBuffer) {
  const shape = process.env.HF_JSON_SHAPE || 'image_urls';
  const prompt = process.env.HF_PROMPT || '';
  const base64 = imageBuffer.toString('base64');

  if (shape === 'generic') {
    // Generic HF image-to-image spec: base64 inputs + nested parameters.prompt.
    const imageField = process.env.HF_IMAGE_FIELD || 'inputs';
    const payload = { [imageField]: base64 };
    if (prompt) payload.parameters = { prompt };
    return payload;
  }

  // 'image_urls' (default): fal-ai style edit models, image as a data URI array.
  const imageField = process.env.HF_IMAGE_FIELD || 'image_urls';
  const payload = {};
  if (prompt) payload.prompt = prompt;
  payload[imageField] = [`data:image/png;base64,${base64}`];
  return payload;
}

function buildPayload(imageBuffer, maskBuffer) {
  const mode = process.env.HF_INPUT_MODE || 'json';

  if (mode === 'binary') {
    return {
      body: imageBuffer,
      headers: { 'Content-Type': process.env.HF_IMAGE_CONTENT_TYPE || 'application/octet-stream' },
    };
  }

  if (mode === 'multipart') {
    const imageField = process.env.HF_IMAGE_FIELD || 'image_file';
    const maskField = process.env.HF_MASK_FIELD || 'mask_file';
    const form = new FormData();
    form.append(imageField, new Blob([imageBuffer]), 'image.png');
    if (maskBuffer) {
      form.append(maskField, new Blob([maskBuffer]), 'mask.png');
    }
    return { body: form, headers: {} };
  }

  return {
    body: JSON.stringify(buildJsonPayload(imageBuffer)),
    headers: { 'Content-Type': 'application/json' },
  };
}

function looksLikeImage(buffer) {
  return IMAGE_MAGIC.some(({ bytes }) => bytes.every((b, i) => buffer[i] === b));
}

const DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /\.internal$/i,
  /\.local$/i,
];

/**
 * The download URL comes from the model's response, i.e. from outside this
 * system — treat it as untrusted: https only, no private/link-local hosts
 * (SSRF into the deploy network, including cloud metadata endpoints), never
 * the HF bearer token, and a bounded timeout plus size cap.
 */
function assertSafeDownloadUrl(rawUrl, model) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ProviderError(`Model returned an unparseable image URL: ${String(rawUrl).slice(0, 200)}`, {
      provider: 'huggingface',
      model,
    });
  }
  if (parsed.protocol !== 'https:') {
    throw new ProviderError(`Refusing to download generated image over "${parsed.protocol}" (https required)`, {
      provider: 'huggingface',
      model,
    });
  }
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))) {
    throw new ProviderError(`Refusing to download generated image from non-public host "${parsed.hostname}"`, {
      provider: 'huggingface',
      model,
    });
  }
  return parsed;
}

async function fetchRemoteImage(url, model) {
  const safeUrl = assertSafeDownloadUrl(url, model);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let response;
  try {
    // No Authorization header: the destination is model-controlled.
    response = await fetch(safeUrl, { redirect: 'error', signal: controller.signal });
  } catch (err) {
    throw new ProviderError(`Failed to download generated image from ${safeUrl.origin}: ${err.message}`, {
      provider: 'huggingface',
      model,
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new ProviderError(`Failed to download generated image from ${safeUrl.origin} (HTTP ${response.status})`, {
      provider: 'huggingface',
      model,
    });
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
    throw new ProviderError(`Generated image is larger than the ${MAX_DOWNLOAD_BYTES} byte limit`, {
      provider: 'huggingface',
      model,
    });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new ProviderError(`Generated image is larger than the ${MAX_DOWNLOAD_BYTES} byte limit`, {
      provider: 'huggingface',
      model,
    });
  }
  if (!looksLikeImage(buffer)) {
    throw new ProviderError('Downloaded generated "image" is not a recognizable image format', {
      provider: 'huggingface',
      model,
    });
  }
  return buffer;
}

async function parseImageResponse(response, model) {
  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());

  if (contentType.startsWith('image/') || looksLikeImage(buffer)) {
    return buffer;
  }

  const text = buffer.toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError(`Unexpected response from Hugging Face model "${model}" (${contentType || 'no content-type'}): ${text.slice(0, 300)}`, {
      provider: 'huggingface',
      model,
    });
  }

  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of candidates) {
    const images = entry && Array.isArray(entry.images) ? entry.images : [];
    if (images.length > 0 && typeof images[0].url === 'string') {
      return fetchRemoteImage(images[0].url, model);
    }

    const base64 = entry && (entry.generated_image || entry.image || entry.output || entry.b64_json);
    if (typeof base64 === 'string' && base64.length > 0) {
      return Buffer.from(base64, 'base64');
    }
  }

  throw new ProviderError(`Hugging Face model "${model}" returned JSON without an image field: ${text.slice(0, 300)}`, {
    provider: 'huggingface',
    model,
  });
}

async function cleanup(imageBuffer, maskBuffer) {
  const { apiKey, model, url } = readConfig();
  const { body, headers } = buildPayload(imageBuffer, maskBuffer);

  const response = await post({
    url,
    provider: 'huggingface',
    model,
    headers: { Authorization: `Bearer ${apiKey}`, ...headers },
    body,
  });

  return parseImageResponse(response, model);
}

module.exports = { cleanup };
