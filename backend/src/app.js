require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { requireAccessKey, isValidKey } = require('./middleware/accessKey.middleware');
const { errorHandler } = require('./middleware/errorHandler.middleware');
const { requestId } = require('./middleware/requestId.middleware');

const paintsRoutes = require('./routes/paints.routes');
const importExportRoutes = require('./routes/importExport.routes');
const projectsRoutes = require('./routes/projects.routes');
const assetsRoutes = require('./routes/assets.routes');
const layersRoutes = require('./routes/layers.routes');
const exportsRoutes = require('./routes/exports.routes');
const metaRoutes = require('./routes/meta.routes');

const storage = require('./services/storage.service');

const app = express();

// The frontend runs on a different origin/port and loads photos, masks, and
// exports as <img>/<canvas> sources for client-side recolor compositing —
// helmet's default same-origin Cross-Origin-Resource-Policy would have the
// browser block those loads even with CORS configured correctly, since CORP
// is enforced independently of CORS.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(morgan('combined'));
app.use(requestId);
app.use(express.json({ limit: '2mb' }));

// Rate limit upload-heavy endpoints specifically.
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/projects/:projectId/assets', uploadLimiter);
app.use('/api/catalog/import', uploadLimiter);

// /clean calls a billed external inpainting API per request (unlike the
// limiters above, which just guard local disk/DB writes) — a much tighter
// cap so a retry loop or a stray automation can't run up the provider bill.
const cleanupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use('/api/assets/:assetId/clean', cleanupLimiter);

// Same reasoning for the two AI capabilities that can be configured to call
// a billed external provider (house-understanding/hf-vision, and — via the
// autonomous pipeline's /process — both in sequence). `skip` excludes GET
// so polling /ai/analysis, /ai/recommendations, or /ai/status (cheap DB
// reads, and /ai/status is polled every 2s while a job runs) is never
// throttled — only the calls that actually trigger provider work are.
const aiRunLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skip: (req) => req.method !== 'POST',
});
app.use('/api/assets/:assetId/ai/analyze', aiRunLimiter);
app.use('/api/assets/:assetId/ai/recommendations', aiRunLimiter);
app.use('/api/assets/:assetId/ai/process', aiRunLimiter);

app.use('/api', requireAccessKey);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/catalog', paintsRoutes);
app.use('/api/catalog/import', importExportRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/layers', layersRoutes);
app.use('/api/exports', exportsRoutes);
app.use('/api/meta', metaRoutes);

// Serve stored images through a controlled route rather than exposing the
// upload folder directly. This is every photo, mask, concept thumbnail, and
// export the app has ever stored, so it carries the same access-key gate as
// /api — but a plain <img src>/Konva Image load can't attach the x-api-key
// header, so the key is also accepted as a ?key= query param here (and only
// here; /api never accepts it that way, since query strings end up in
// server logs and browser history more readily than headers do).
app.get('/files/*', async (req, res, next) => {
  try {
    if (!isValidKey(req.header('x-api-key') || req.query.key)) {
      return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    const relativePath = req.params[0];
    if (!(await storage.exists(relativePath))) return res.status(404).json({ error: 'File not found' });
    res.sendFile(storage.absolutePath(relativePath));
  } catch (err) { next(err); }
});

app.use(errorHandler);

module.exports = app;
