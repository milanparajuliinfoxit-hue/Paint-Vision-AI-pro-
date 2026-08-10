const storage = require('../services/storage.service');
const layersModel = require('../services/layers.model');
const assetsModel = require('../services/assets.model');
const { asyncHandler } = require('../utils/asyncHandler');
const { badRequest, notFound } = require('../utils/httpError');

const CREATED_VIA_VALUES = ['brush', 'magic-wand', 'lasso', 'rect', 'polygon', 'ai-surface'];

const saveMask = (assetId, buffer) =>
  storage.saveBuffer(storage.maskDir(assetId), `layer_${Date.now()}.png`, buffer);

const createLayer = asyncHandler(async (req, res) => {
  const asset = await assetsModel.getAssetOrFail(req.params.assetId);

  const { name, createdVia, currentColorId, opacity, orderIndex } = req.body;
  if (!name || !createdVia) throw badRequest('name and createdVia are required');
  if (!CREATED_VIA_VALUES.includes(createdVia)) {
    throw badRequest(`createdVia must be one of: ${CREATED_VIA_VALUES.join(', ')}`);
  }

  // The mask is a compressed alpha PNG stored on disk, not inline pixel
  // data (requirements doc, Section 5.2) — reuses the same storage pattern
  // as the source photo.
  const maskPath = req.file ? saveMask(asset.id, req.file.buffer) : null;

  const layer = await layersModel.createLayer({
    assetId: asset.id,
    name,
    maskPath,
    createdVia,
    currentColorId: currentColorId || null,
    opacity: opacity !== undefined ? Number(opacity) : undefined,
    orderIndex: orderIndex !== undefined ? Number(orderIndex) : undefined,
  });
  res.status(201).json(layer);
});

const listLayers = asyncHandler(async (req, res) => {
  res.json(await layersModel.listLayersForAsset(req.params.assetId));
});

const NUMERIC_PATCH_FIELDS = ['currentColorId', 'opacity', 'orderIndex'];
const BOOLEAN_PATCH_FIELDS = ['locked', 'visible'];

async function getLayerOrFail(id) {
  const layer = await layersModel.getLayer(id);
  if (!layer) throw notFound('Layer not found');
  return layer;
}

const updateLayer = asyncHandler(async (req, res) => {
  const existing = await getLayerOrFail(req.params.id);

  const { updatedAt, ...rawPatch } = req.body;
  const patch = { ...rawPatch };

  // A brush stroke in mask-edit mode re-uploads the merged mask alongside
  // the rest of the patch as multipart form-data (requirements doc,
  // Section 5.2) — everything else PATCHes as plain JSON. Multer leaves
  // req.body untouched for non-multipart requests, so form-field strings
  // only need coercion on the multipart path.
  if (req.file) {
    patch.maskPath = saveMask(existing.asset_id, req.file.buffer);
    for (const field of NUMERIC_PATCH_FIELDS) {
      if (patch[field] !== undefined) patch[field] = Number(patch[field]);
    }
    for (const field of BOOLEAN_PATCH_FIELDS) {
      if (patch[field] !== undefined) patch[field] = patch[field] === 'true' || patch[field] === true;
    }
  }

  res.json(await layersModel.updateLayer(req.params.id, patch, updatedAt));
});

const deleteLayer = asyncHandler(async (req, res) => {
  await getLayerOrFail(req.params.id);
  await layersModel.deleteLayer(req.params.id);
  res.status(204).send();
});

// Undo of a delete (or redo of a create) — brings a soft-deleted layer back
// with the same id and mask, rather than recreating a new row.
const restoreLayer = asyncHandler(async (req, res) => {
  const existing = await layersModel.getLayerIncludingDeleted(req.params.id);
  if (!existing) throw notFound('Layer not found');
  res.json(await layersModel.restoreLayer(req.params.id));
});

module.exports = { createLayer, listLayers, updateLayer, deleteLayer, restoreLayer };
