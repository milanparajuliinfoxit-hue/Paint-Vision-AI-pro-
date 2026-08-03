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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/catalog', paintsRoutes);
app.use('/api/catalog/import', importExportRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/layers', layersRoutes);
app.use('/api/exports', exportsRoutes);

// Serve stored images through a controlled route rather than exposing the
// upload folder directly — keeps the door open for access control later.
app.get('/files/*', (req, res, next) => {
  try {
    const relativePath = req.params[0];
    if (!storage.exists(relativePath)) return res.status(404).json({ error: 'File not found' });
    res.sendFile(storage.absolutePath(relativePath));
  } catch (err) { next(err); }
});

app.use(errorHandler);

module.exports = app;
