const multer = require('multer');

const DEFAULT_MAX_MB = 10;

/**
 * Every upload route uses the same in-memory multer setup (buffers are handed
 * straight to storage.service, nothing is written by multer itself) and only
 * differs in the size cap.
 */
function memoryUpload(maxMb = DEFAULT_MAX_MB) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * 1024 * 1024 },
  });
}

module.exports = { memoryUpload, DEFAULT_MAX_MB };
