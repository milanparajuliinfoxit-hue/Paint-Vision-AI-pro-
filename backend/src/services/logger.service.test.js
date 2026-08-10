const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// LOG_DIR/MAX_BYTES are read at module-load time, so point them at a scratch
// directory before requiring — real backend/logs/ is never touched by this
// suite, and rotation is tested with a tiny threshold instead of real
// megabytes of writes.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
process.env.LOG_DIR = scratchDir;
process.env.LOG_MAX_BYTES = '200';
const logger = require('./logger.service');

const APPLICATION_LOG = path.join(scratchDir, 'application.log');
const ERROR_LOG = path.join(scratchDir, 'error.log');

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test.after(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

test('info() writes a structured line to application.log only', () => {
  logger.info({ event: 'test.info', foo: 'bar' });
  const lines = readLines(APPLICATION_LOG);
  const last = lines[lines.length - 1];
  assert.equal(last.level, 'info');
  assert.equal(last.event, 'test.info');
  assert.equal(last.foo, 'bar');
  assert.ok(last.timestamp);
  assert.equal(readLines(ERROR_LOG).length, 0);
});

test('error() writes to both application.log and error.log', () => {
  const beforeApp = readLines(APPLICATION_LOG).length;
  const beforeErr = readLines(ERROR_LOG).length;
  logger.error({ event: 'test.error', message: 'boom' });
  assert.equal(readLines(APPLICATION_LOG).length, beforeApp + 1);
  assert.equal(readLines(ERROR_LOG).length, beforeErr + 1);
  assert.equal(readLines(ERROR_LOG).pop().event, 'test.error');
});

test('warn() and debug() never write to error.log', () => {
  const before = readLines(ERROR_LOG).length;
  logger.warn({ event: 'test.warn' });
  logger.debug({ event: 'test.debug' });
  assert.equal(readLines(ERROR_LOG).length, before);
});

test('rotation: exceeding LOG_MAX_BYTES rolls the file to .1 and starts fresh', () => {
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-rotate-'));
  process.env.LOG_DIR = freshDir;
  delete require.cache[require.resolve('./logger.service')];
  const freshLogger = require('./logger.service');
  const appLog = path.join(freshDir, 'application.log');

  for (let i = 0; i < 10; i++) freshLogger.info({ event: 'fill', i, padding: 'x'.repeat(30) });
  assert.ok(fs.statSync(appLog).size > 200, 'precondition: file should have exceeded the tiny threshold');

  freshLogger.info({ event: 'triggers.rotation' });
  assert.ok(fs.existsSync(`${appLog}.1`), 'expected a .1 rollover file to exist');
  const currentLines = readLines(appLog);
  assert.equal(currentLines.length, 1, 'current file should only contain the write that triggered rotation');
  assert.equal(currentLines[0].event, 'triggers.rotation');

  fs.rmSync(freshDir, { recursive: true, force: true });
});

test('redactHeaders masks Authorization/Cookie/X-API-Key but leaves other headers untouched', () => {
  const redacted = logger.redactHeaders({
    Authorization: 'Bearer secret-token',
    'x-api-key': 'super-secret',
    Cookie: 'session=abc',
    'Content-Type': 'application/json',
  });
  assert.equal(redacted.Authorization, '[REDACTED]');
  assert.equal(redacted['x-api-key'], '[REDACTED]');
  assert.equal(redacted.Cookie, '[REDACTED]');
  assert.equal(redacted['Content-Type'], 'application/json');
});

test('logging never throws even if the log directory is unwritable', () => {
  process.env.LOG_DIR = path.join(scratchDir, 'does', 'not', 'exist', 'and', 'cannot', 'be', 'created\0invalid');
  delete require.cache[require.resolve('./logger.service')];
  assert.doesNotThrow(() => {
    const brokenLogger = require('./logger.service');
    brokenLogger.info({ event: 'should.not.throw' });
    brokenLogger.error({ event: 'should.not.throw.either' });
  });
});
