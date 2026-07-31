const clipdrop = require('./providers/clipdrop');
const huggingface = require('./providers/huggingface');

/**
 * AI provider dispatcher.
 *
 * Only responsible for selecting a provider based on AI_PROVIDER. All
 * provider-specific behavior lives in ./providers/<name>.js, so adding a
 * provider requires only a new file there (plus a case below) — routes,
 * controllers, and the frontend are untouched.
 *
 * Public contract (unchanged): callCleanup(imageBuffer, maskBuffer) → Promise<Buffer>
 */
async function callCleanup(imageBuffer, maskBuffer) {
  const provider = process.env.AI_PROVIDER || 'clipdrop';

  switch (provider) {
    case 'clipdrop':
      return clipdrop.cleanup(imageBuffer, maskBuffer);
    case 'huggingface':
      return huggingface.cleanup(imageBuffer, maskBuffer);
    default:
      throw new Error(`Unsupported AI_PROVIDER: "${provider}". Supported providers: clipdrop, huggingface.`);
  }
}

module.exports = { callCleanup };
