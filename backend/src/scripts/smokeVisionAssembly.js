/* Offline self-test for the house-understanding contract assembly.
 *
 * Builds a synthetic 640x640 scene (sky, roof, walls, door, windows, tree,
 * fence, ground) with known class masks, runs the pure geometry in
 * src/services/ai/visionAssembly.js, and asserts the app contract it must
 * produce. No API keys, no network — this verifies the risky port from the
 * local Python pipeline independently of any hosted model.
 *
 * Usage (run from backend/):
 *   npm run smoke:vision
 */
const { assembleContract } = require('../services/ai/visionAssembly');

const W = 640;
const H = 640;
const N = W * H;

function paintScene() {
  const rgb = new Uint8Array(N * 3);
  const masks = {};
  for (const cls of ['roof', 'wall', 'window', 'door', 'tree', 'fence', 'sky', 'ground']) {
    masks[cls] = new Uint8Array(N);
  }

  const skyColor = [135, 206, 250];
  const groundColor = [120, 130, 110];
  const roofColor = [80, 60, 55];
  const wallColor = [230, 220, 200];
  const windowColor = [40, 50, 70];
  const doorColor = [90, 60, 40];
  const treeColor = [60, 120, 60];
  const fenceColor = [100, 80, 60];

  const inRect = (x, y, x0, x1, y0, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const windowHit = (x, y) =>
    (inRect(x, y, 180, 230, 260, 300) || inRect(x, y, 400, 450, 260, 300));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let c = [0, 0, 0];
      let cls = null;

      if (inRect(x, y, 0, W - 1, 0, 150)) { c = skyColor; cls = 'sky'; }
      else if (inRect(x, y, 0, W - 1, 500, H - 1)) { c = groundColor; cls = 'ground'; }
      else if (inRect(x, y, 40, 100, 300, 420)) { c = treeColor; cls = 'tree'; }
      else if (inRect(x, y, 550, 590, 430, 499)) { c = fenceColor; cls = 'fence'; }
      else if (inRect(x, y, 120, 519, 150, 499)) {
        if (windowHit(x, y)) { c = windowColor; cls = 'window'; }
        else if (inRect(x, y, 300, 340, 380, 499)) { c = doorColor; cls = 'door'; }
        else if (y <= 199) { c = roofColor; cls = 'roof'; }
        else { c = wallColor; cls = 'wall'; }
      }

      rgb[i * 3] = c[0];
      rgb[i * 3 + 1] = c[1];
      rgb[i * 3 + 2] = c[2];
      if (cls) masks[cls][i] = 1;
    }
  }

  return { rgb, masks };
}

function assert(checks, label, fn) {
  try {
    const ok = fn();
    checks.push({ label, ok, detail: ok ? 'ok' : 'FAILED' });
  } catch (err) {
    checks.push({ label, ok: false, detail: err.message });
  }
}

function main() {
  const checks = [];
  const { rgb, masks } = paintScene();
  const out = assembleContract({ width: W, height: H, rgb, classMasks: masks, classConfidences: { roof: 0.9, wall: 0.8, window: 0.7, door: 0.6, tree: 0.7, fence: 0.5, sky: 0.9, ground: 0.9 }, scale: 0.5 });

  assert(checks, 'house detected as present', () => out.house.present === true);
  assert(checks, 'house bbox within image', () => {
    const b = out.house.bbox;
    return b && b.w > 100 && b.h > 100 && b.w * b.h / N > 0.03;
  });
  assert(checks, 'house confidence in [0.3, 0.95]', () => out.house.confidence >= 0.3 && out.house.confidence <= 0.95);
  assert(checks, 'house style/material strings', () => typeof out.house.style === 'string' && typeof out.house.material === 'string');

  const front = out.surfaces.find((s) => s.key === 'front-wall');
  assert(checks, 'front-wall surface present + paintable + role', () =>
    front && front.paintable === true && front.role === 'primary-wall' && front.displayName === 'Front wall');

  assert(checks, 'roof/trim/door surfaces present', () =>
    ['roof', 'trim', 'door'].every((k) => out.surfaces.some((s) => s.key === k)));

  assert(checks, 'surface masks sized N with 0/255 alpha', () =>
    out.surfaces.every((s) =>
      s.mask.width === W && s.mask.height === H &&
      s.mask.alpha.length === N &&
      s.mask.alpha.every((v) => v === 0 || v === 255)));

  assert(checks, 'surface geometry sane', () =>
    out.surfaces.every((s) =>
      s.geometry.areaPx > 0 && s.geometry.areaRatio > 0 && s.geometry.areaRatio <= 1 &&
      Number.isFinite(s.geometry.areaRatio)));

  assert(checks, 'surface averageColor is RGB', () =>
    out.surfaces.every((s) => {
      const c = s.averageColor;
      return c && Number.isInteger(c.r) && c.r >= 0 && c.r <= 255;
    }));

  const tree = out.objects.find((o) => o.key === 'tree');
  assert(checks, 'tree object present and non-paintable', () => tree && tree.paintable === false);
  assert(checks, 'window object present', () => out.objects.some((o) => o.key === 'windows'));

  assert(checks, 'context wallColor near painted wall', () => {
    const w = out.context.wallColor;
    return w && Math.abs(w.r - 230) < 40 && Math.abs(w.g - 220) < 40;
  });
  assert(checks, 'context palette length 5', () => Array.isArray(out.context.palette) && out.context.palette.length === 5);
  assert(checks, 'context lighting in [0.7, 1.3]', () => out.context.lighting >= 0.7 && out.context.lighting <= 1.3);

  assert(checks, 'no NaN in contract floats', () => {
    const floats = [
      out.house.confidence, out.context.lighting, out.scale.factor,
      ...out.surfaces.flatMap((s) => [s.confidence, s.geometry.areaRatio, s.averageColor.r, s.averageColor.g, s.averageColor.b]),
      ...out.objects.flatMap((o) => [o.confidence, o.geometry.areaRatio]),
    ];
    return floats.every((v) => Number.isFinite(v));
  });

  // Absent-house path: empty masks must yield a valid empty contract.
  const empty = {};
  for (const cls of Object.keys(masks)) empty[cls] = new Uint8Array(N);
  const emptyOut = assembleContract({ width: W, height: H, rgb, classMasks: empty });
  assert(checks, 'no-house: present=false, surfaces/objects empty', () =>
    emptyOut.house.present === false && emptyOut.surfaces.length === 0 && emptyOut.objects.length === 0);
  assert(checks, 'no-house: palette still populated', () =>
    Array.isArray(emptyOut.context.palette) && emptyOut.context.palette.length === 5);

  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.ok ? '' : ` — ${c.detail}`}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

main();
