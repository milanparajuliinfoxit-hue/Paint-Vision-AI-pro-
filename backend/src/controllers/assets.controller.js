const { v4: uuidv4 } = require('uuid');
const storage = require('../services/storage.service');
const assetsModel = require('../services/assets.model');
const projectsModel = require('../services/projects.model');
const layersModel = require('../services/layers.model');
const aiProxy = require('../services/aiProxy.service');

async function uploadAsset(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const project = await projectsModel.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Create the row first (so we have an id for the folder name), then
    // save the file and record the real path — mirrors storage.service's
    // id-keyed folder layout.
    const asset = await assetsModel.createAsset({ projectId: project.id, originalPath: '' });
    // UPLOAD_ROOT already ends in the app's uploads folder — asset.id alone
    // is enough, no need to re-nest under another 'uploads' segment.
    const relativeDir = asset.id;
    const relativePath = storage.saveBuffer(relativeDir, 'original.jpg', req.file.buffer);
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

    const imageBuffer = storage.readFile(asset.original_path);
    const maskBuffer = req.file ? req.file.buffer : null; // optional user-drawn "remove this" mask

    const cleanedBuffer = await aiProxy.callCleanup(imageBuffer, maskBuffer);

    // UPLOAD_ROOT already ends in the app's uploads folder — asset.id alone
    // is enough, no need to re-nest under another 'uploads' segment.
    const relativeDir = asset.id;
    const cleanedPath = storage.saveBuffer(relativeDir, 'cleaned.jpg', cleanedBuffer);

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

    // Grab mask paths before the row (and its layers, via FK cascade)
    // disappears — including soft-deleted layers, since their mask files
    // are still real files on disk that need cleaning up too.
    const layers = await layersModel.listAllLayersForAsset(asset.id);
    const project = asset.project_id ? await projectsModel.getProject(asset.project_id) : null;

    await assetsModel.deleteAsset(asset.id);

    // Don't leave a project's cover pointing at a now-deleted asset — hand
    // the thumbnail off to whatever's left, or clear it if nothing remains.
    if (project?.cover_asset_id === asset.id) {
      const remaining = await assetsModel.listAssetsForProject(project.id);
      await projectsModel.updateProject(project.id, { coverAssetId: remaining[0]?.id || null });
    }

    storage.deleteFile(asset.original_path);
    if (asset.cleaned_path) storage.deleteFile(asset.cleaned_path);
    for (const layer of layers) {
      if (layer.mask_path) storage.deleteFile(layer.mask_path);
    }
    storage.deleteDirIfEmpty(asset.id);

    res.status(204).end();
  } catch (err) { next(err); }
}

async function duplicateAsset(req, res, next) {
  try {
    const asset = await assetsModel.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const newId = uuidv4();
    const originalPath = storage.saveBuffer(newId, 'original.jpg', storage.readFile(asset.original_path));
    const cleanedPath = asset.cleaned_path
      ? storage.saveBuffer(newId, 'cleaned.jpg', storage.readFile(asset.cleaned_path))
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
