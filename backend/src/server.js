const app = require('./app');
const logger = require('./services/logger.service');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  logger.info({ event: 'server.startup', port: Number(PORT) });
});
