require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { requireAccessKey } = require('./middleware/accessKey.middleware');
const { errorHandler } = require('./middleware/errorHandler.middleware');

const paintsRoutes = require('./routes/paints.routes');
const importExportRoutes = require('./routes/importExport.routes');
const projectsRoutes = require('./routes/projects.routes');
const assetsRoutes = require('./routes/assets.routes');
const layersRoutes = require('./routes/layers.routes');
const exportsRoutes = require('./routes/exports.routes');

const storage = require('./services/storage.service');
const logger = require('./services/logger.service');
const db = require('./config/db');

const app = express();

// The frontend runs on a different origin/port and loads photos, masks, and
// exports as <img>/<canvas> sources for client-side recolor compositing —
// helmet's default same-origin Cross-Origin-Resource-Policy would have the
// browser block those loads even with CORS configured correctly, since CORP
// is enforced independently of CORS.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(morgan('combined'));
app.use(express.json({ limit: '2mb' }));

// Rate limit upload-heavy endpoints specifically.
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/projects/:projectId/assets', uploadLimiter);
app.use('/api/catalog/import', uploadLimiter);

app.use('/api', requireAccessKey);

// Reports the dependency the app can't work without. Previously this always
// answered "ok", so an unreachable database looked healthy to any monitor.
app.get('/health', async (req, res) => {
  try {
    await db.ping();
    res.json({ status: 'ok', database: 'ok' });
  } catch (err) {
    logger.error({ message: `Health check failed: ${err.message}`, code: err.code });
    res.status(503).json({ status: 'degraded', database: 'unreachable' });
  }
});

app.use('/api/catalog', paintsRoutes);
app.use('/api/catalog/import', importExportRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/layers', layersRoutes);
app.use('/api/exports', exportsRoutes);

// Serve stored images through a controlled route rather than exposing the
// upload folder directly — keeps the door open for access control later.
app.get('/files/*', (req, res, next) => {
  let absolute;
  try {
    const relativePath = req.params[0];
    if (!storage.exists(relativePath)) return res.status(404).json({ error: 'File not found' });
    absolute = storage.absolutePath(relativePath);
  } catch (err) { return next(err); }

  // sendFile reports read/stream failures through its callback, not by
  // throwing — without it a mid-stream failure left the request hanging
  // until the client timed out, with nothing logged.
  res.sendFile(absolute, (err) => {
    if (err) next(err);
  });
});

// Unknown API paths get a JSON 404 like every other API error, instead of
// Express's default HTML page that the frontend's fetch wrapper can't parse.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown API endpoint: ${req.method} ${req.originalUrl}` });
});

app.use(errorHandler);

module.exports = app;
