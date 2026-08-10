const { v4: uuidv4 } = require('uuid');
const Jimp = require('jimp');
const storage = require('../services/storage.service');
const assetsModel = require('../services/assets.model');
const projectsModel = require('../services/projects.model');
const aiProxy = require('../services/aiProxy.service');
const logger = require('../services/logger.service');
const objectRemovalMask = require('../services/ai/objectRemovalMask.service');
const removalQuality = require('../services/ai/removalQuality.service');
const { isRealImage, exceedsMaxDimensions, MAX_IMAGE_DIMENSION } = require('../middleware/uploadValidation.middleware');

async function uploadAsset(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    // multer's fileFilter only checked the client-declared Content-Type,
    // which a request can lie about — this checks the actual bytes.
    if (!isRealImage(req.file.buffer)) {
      return res.status(400).json({ error: 'That file is not a valid image.' });
    }
    // Decompression-bomb guard: reject an oversized image by its *header*
    // dimensions before it's ever written to disk or decoded anywhere
    // downstream (analysis, cleanup mask sizing all Jimp.read() it later).
    if (exceedsMaxDimensions(req.file.buffer)) {
      return res.status(400).json({ error: `Image dimensions exceed the ${MAX_IMAGE_DIMENSION}px limit.` });
    }
    const project = await projectsModel.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Create the row first (so we have an id for the folder name), then
    // save the file and record the real path — mirrors storage.service's
    // id-keyed folder layout.
    const asset = await assetsModel.createAsset({ projectId: project.id, originalPath: '' });
    // UPLOAD_ROOT already ends in the app's uploads folder — asset.id alone
    // is enough, no need to re-nest under another 'uploads' segment.
    const relativeDir = asset.id;
    const relativePath = await storage.saveBuffer(relativeDir, 'original.jpg', req.file.buffer);
    const updated = await assetsModel.updateAssetOriginalPath(asset.id, relativePath);

    // First photo on a project becomes its cover thumbnail automatically —
    // otherwise every project card on Dashboard/Projects stays blank forever
    // since nothing else ever sets cover_asset_id.
    if (!project.cover_asset_id) {
      await projectsModel.updateProject(project.id, { coverAssetId: asset.id });
    }

    res.status(201).json(updated);
  } catch (err) { next(err); }
}

async function getAsset(req, res, next) {
  try {
    const asset = await assetsModel.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json(asset);
  } catch (err) { next(err); }
}

async function listAssets(req, res, next) {
  try {
    res.json(await assetsModel.listAssetsForProject(req.params.projectId));
  } catch (err) { next(err); }
}

// Thin proxy: forwards to the hosted AI API and stores the result. No image
// processing happens in this process (requirements doc, Section 6.3/9).
async function requestCleanup(req, res, next) {
  try {
    const asset = await assetsModel.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    await assetsModel.updateAssetStatus(asset.id, { status: 'cleaning' });

    const imageBuffer = await storage.readFile(asset.original_path);
    // An explicit user-drawn mask always wins outright — no merging, no
    // second-guessing a deliberate selection. Only when the dealer hasn't
    // drawn anything do we fall back to a mask built from the asset's own
    // house-understanding (detected tree/car/person/fence, house surfaces
    // always protected — see objectRemovalMask.service.js). If there's no
    // analysis yet, or nothing removable was detected, this resolves to
    // null and cleanup runs exactly as it did before this feature existed.
    let maskBuffer = req.file ? req.file.buffer : null;
    if (!maskBuffer) {
      const dims = await Jimp.read(imageBuffer);
      maskBuffer = await objectRemovalMask.buildDefaultRemovalMask(asset.id, dims.bitmap.width, dims.bitmap.height);
    }

    const cleanedBuffer = await aiProxy.callCleanup(imageBuffer, maskBuffer);

    // Reject the result outright if it changed the house itself too much —
    // a correct mask doesn't guarantee the inpainting model actually
    // respected it. The original is retained; nothing is written to disk.
    const damageCheck = await removalQuality.checkHouseDamage(asset.id, imageBuffer, cleanedBuffer);
    if (damageCheck.damaged) {
      const reverted = await assetsModel.updateAssetStatus(asset.id, {
        status: 'uploaded',
        errorMessage: `Cleanup was skipped — it would have altered ${Math.round(damageCheck.changedFraction * 100)}% of the house itself, not just the surroundings.`,
      });
      return res.json({ ...reverted, cleanupRejected: true });
    }

    // UPLOAD_ROOT already ends in the app's uploads folder — asset.id alone
    // is enough, no need to re-nest under another 'uploads' segment.
    const relativeDir = asset.id;
    const cleanedPath = await storage.saveBuffer(relativeDir, 'cleaned.jpg', cleanedBuffer);

    const updated = await assetsModel.updateAssetStatus(asset.id, { status: 'cleaned', cleanedPath });
    res.json(updated);
  } catch (err) {
    if (req.params.assetId) {
      await assetsModel.updateAssetStatus(req.params.assetId, { status: 'failed', errorMessage: err.message });
    }
    next(err);
  }
}

async function renameAsset(req, res, next) {
  try {
    const { label } = req.body;
    if (typeof label !== 'string' || !label.trim()) {
      return res.status(400).json({ error: 'label is required' });
    }
    const asset = await assetsModel.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json(await assetsModel.renameAsset(asset.id, label.trim()));
  } catch (err) { next(err); }
}

async function deleteAsset(req, res, next) {
  try {
    const asset = await assetsModel.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const project = asset.project_id ? await projectsModel.getProject(asset.project_id) : null;

    await assetsModel.deleteAsset(asset.id);

    // Don't leave a project's cover pointing at a now-deleted asset — hand
    // the thumbnail off to whatever's left, or clear it if nothing remains.
    if (project?.cover_asset_id === asset.id) {
      const remaining = await assetsModel.listAssetsForProject(project.id);
      await projectsModel.updateProject(project.id, { coverAssetId: remaining[0]?.id || null });
    }

    // Best-effort disk cleanup after the DB commit — never rolls back an
    // already-committed delete. An asset owns two disjoint real locations
    // on disk (see storage.service.js's removeTree comment): <assetId>/
    // for original/cleaned photos + AI masks, and the separate
    // uploads/<assetId>/ wrapper for layer masks (layers.controller.js's
    // relativeDir nests under an extra literal "uploads" segment that
    // asset photos don't). Both are removed in full rather than
    // enumerating known files — the previous file-by-file approach missed
    // the masks wrapper entirely, leaving orphaned UUID directories behind.
    try {
      await storage.removeTree(asset.id);
      await storage.removeTree(`uploads/${asset.id}`);
    } catch (err) {
      logger.error({ event: 'asset.delete.filesystem_cleanup_failed', assetId: asset.id, error: err.message });
    }

    res.status(204).end();
  } catch (err) { next(err); }
}

async function duplicateAsset(req, res, next) {
  try {
    const asset = await assetsModel.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const newId = uuidv4();
    const originalPath = await storage.saveBuffer(newId, 'original.jpg', await storage.readFile(asset.original_path));
    const cleanedPath = asset.cleaned_path
      ? await storage.saveBuffer(newId, 'cleaned.jpg', await storage.readFile(asset.cleaned_path))
      : null;

    const copy = await assetsModel.insertDuplicate({
      id: newId,
      projectId: asset.project_id,
      label: `${asset.label || (asset.cleaned_path ? 'Cleaned' : 'Original')} copy`,
      originalPath,
      cleanedPath,
      status: asset.status === 'failed' ? 'uploaded' : asset.status,
    });

    res.status(201).json(copy);
  } catch (err) { next(err); }
}

module.exports = { uploadAsset, getAsset, listAssets, requestCleanup, renameAsset, deleteAsset, duplicateAsset };
