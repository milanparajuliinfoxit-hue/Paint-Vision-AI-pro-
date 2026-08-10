const app = require('./app');
const logger = require('./services/logger.service');

const PORT = process.env.PORT || 4000;

const server = app.listen(PORT, () => {
  logger.info({ message: `Paint Visualizer backend listening on port ${PORT}`, port: Number(PORT) });
});

// Without this, a port already in use (or a permission error) surfaced only
// as an unhandled 'error' event and killed the process with no context.
server.on('error', (err) => {
  logger.error({ message: `Server failed to start: ${err.message}`, code: err.code, port: Number(PORT) });
  process.exit(1);
});

// A rejected promise nobody awaited used to be printed by Node and ignored;
// under Node >=15 it terminates the process silently from the app's point of
// view. Log it with the same structured shape as every other error first.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error({ message: `Unhandled promise rejection: ${err.message}`, name: err.name, stack: err.stack });
});

// An uncaught exception leaves the process in an undefined state — log it,
// then shut down cleanly (stop accepting connections, drain in-flight ones)
// instead of continuing to serve requests from a corrupted process.
process.on('uncaughtException', (err) => {
  logger.error({ message: `Uncaught exception: ${err.message}`, name: err.name, stack: err.stack });
  shutdown('uncaughtException', 1);
});

function shutdown(signal, exitCode = 0) {
  logger.info({ message: `Shutting down (${signal})` });
  server.close(() => process.exit(exitCode));
  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(exitCode), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
