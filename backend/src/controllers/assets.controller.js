const { v4: uuidv4 } = require('uuid');
const storage = require('../services/storage.service');
const assetsModel = require('../services/assets.model');
const projectsModel = require('../services/projects.model');
const layersModel = require('../services/layers.model');
const aiProxy = require('../services/aiProxy.service');
const { asyncHandler } = require('../utils/asyncHandler');
const { badRequest } = require('../utils/httpError');

const uploadAsset = asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No image uploaded');
  const project = await projectsModel.getProjectOrFail(req.params.projectId);

  // Create the row first (so we have an id for the folder name), then
  // save the file and record the real path — mirrors storage.service's
  // id-keyed folder layout.
  const asset = await assetsModel.createAsset({ projectId: project.id, originalPath: '' });
  const relativePath = storage.saveBuffer(storage.assetDir(asset.id), 'original.jpg', req.file.buffer);
  const updated = await assetsModel.updateAssetOriginalPath(asset.id, relativePath);

  // First photo on a project becomes its cover thumbnail automatically —
  // otherwise every project card on Dashboard/Projects stays blank forever
  // since nothing else ever sets cover_asset_id.
  if (!project.cover_asset_id) {
    await projectsModel.updateProject(project.id, { coverAssetId: asset.id });
  }

  res.status(201).json(updated);
});

const getAsset = asyncHandler(async (req, res) => {
  res.json(await assetsModel.getAssetOrFail(req.params.assetId));
});

const listAssets = asyncHandler(async (req, res) => {
  res.json(await assetsModel.listAssetsForProject(req.params.projectId));
});

// Thin proxy: forwards to the hosted AI API and stores the result. No image
// processing happens in this process (requirements doc, Section 6.3/9).
const requestCleanup = asyncHandler(async (req, res) => {
  const asset = await assetsModel.getAssetOrFail(req.params.assetId);

  await assetsModel.updateAssetStatus(asset.id, { status: 'cleaning' });

  try {
    const imageBuffer = storage.readFile(asset.original_path);
    const maskBuffer = req.file ? req.file.buffer : null; // optional user-drawn "remove this" mask

    const cleanedBuffer = await aiProxy.callCleanup(imageBuffer, maskBuffer);
    const cleanedPath = storage.saveBuffer(storage.assetDir(asset.id), 'cleaned.jpg', cleanedBuffer);

    const updated = await assetsModel.updateAssetStatus(asset.id, { status: 'cleaned', cleanedPath });
    res.json(updated);
  } catch (err) {
    await assetsModel.updateAssetStatus(asset.id, { status: 'failed', errorMessage: err.message });
    throw err;
  }
});

const renameAsset = asyncHandler(async (req, res) => {
  const { label } = req.body;
  if (typeof label !== 'string' || !label.trim()) throw badRequest('label is required');
  const asset = await assetsModel.getAssetOrFail(req.params.assetId);
  res.json(await assetsModel.renameAsset(asset.id, label.trim()));
});

const deleteAsset = asyncHandler(async (req, res) => {
  const asset = await assetsModel.getAssetOrFail(req.params.assetId);

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
  storage.deleteDirIfEmpty(storage.assetDir(asset.id));

  res.status(204).end();
});

const duplicateAsset = asyncHandler(async (req, res) => {
  const asset = await assetsModel.getAssetOrFail(req.params.assetId);

  const newId = uuidv4();
  const dir = storage.assetDir(newId);
  const originalPath = storage.saveBuffer(dir, 'original.jpg', storage.readFile(asset.original_path));
  const cleanedPath = asset.cleaned_path
    ? storage.saveBuffer(dir, 'cleaned.jpg', storage.readFile(asset.cleaned_path))
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
});

module.exports = { uploadAsset, getAsset, listAssets, requestCleanup, renameAsset, deleteAsset, duplicateAsset };
