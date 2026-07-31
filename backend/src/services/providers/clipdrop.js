const { post, ProviderError } = require('./httpClient');

/**
 * Clipdrop Cleanup provider.
 *
 * Behavior preserved from the original single-provider implementation:
 * multipart image (+ optional mask) posted with an x-api-key header.
 */

function buildForm(imageBuffer, maskBuffer) {
  const form = new FormData();
  form.append('image_file', new Blob([imageBuffer]), 'image.jpg');
  if (maskBuffer) {
    form.append('mask_file', new Blob([maskBuffer]), 'mask.png');
  }
  return form;
}

async function cleanup(imageBuffer, maskBuffer) {
  const apiKey = process.env.CLIPDROP_API_KEY;
  if (!apiKey || apiKey.startsWith('replace-with')) {
    throw new ProviderError('CLIPDROP_API_KEY is not configured (see .env.example)', {
      provider: 'clipdrop',
      model: 'cleanup/v1',
    });
  }

  const url = process.env.CLIPDROP_CLEANUP_URL;
  if (!url) {
    throw new ProviderError('CLIPDROP_CLEANUP_URL is not configured (see .env.example)', {
      provider: 'clipdrop',
      model: 'cleanup/v1',
    });
  }

  const response = await post({
    url,
    provider: 'clipdrop',
    model: 'cleanup/v1',
    headers: { 'x-api-key': apiKey },
    body: buildForm(imageBuffer, maskBuffer),
  });

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { cleanup };
