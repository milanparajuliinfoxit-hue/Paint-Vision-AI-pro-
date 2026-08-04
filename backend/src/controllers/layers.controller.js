const path = require('path');
const storage = require('../services/storage.service');
const layersModel = require('../services/layers.model');
const assetsModel = require('../services/assets.model');

const CREATED_VIA_VALUES = ['brush', 'magic-wand', 'lasso', 'rect', 'polygon', 'ai-surface'];

async function createLayer(req, res, next) {
  try {
    const asset = await assetsModel.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const { name, createdVia, currentColorId, opacity, orderIndex, aiSurfaceKey } = req.body;
    if (!name || !createdVia) {
      return res.status(400).json({ error: 'name and createdVia are required' });
    }
    if (!CREATED_VIA_VALUES.includes(createdVia)) {
      return res.status(400).json({ error: `createdVia must be one of: ${CREATED_VIA_VALUES.join(', ')}` });
    }

    // The mask is a compressed alpha PNG stored on disk, not inline pixel
    // data (requirements doc, Section 5.2) — reuses the same storage pattern
    // as the source photo.
    let maskPath = null;
    if (req.file) {
      const relativeDir = path.join('uploads', asset.id, 'masks');
      maskPath = storage.saveBuffer(relativeDir, `layer_${Date.now()}.png`, req.file.buffer);
    }

    const layer = await layersModel.createLayer({
      assetId: asset.id,
      name,
      maskPath,
      createdVia,
      currentColorId: currentColorId || null,
      opacity: opacity !== undefined ? Number(opacity) : undefined,
      orderIndex: orderIndex !== undefined ? Number(orderIndex) : undefined,
      aiSurfaceKey: aiSurfaceKey || null,
    });
    res.status(201).json(layer);
  } catch (err) { next(err); }
}

async function listLayers(req, res, next) {
  try {
    res.json(await layersModel.listLayersForAsset(req.params.assetId));
  } catch (err) { next(err); }
}

const NUMERIC_PATCH_FIELDS = ['currentColorId', 'opacity', 'orderIndex'];
const BOOLEAN_PATCH_FIELDS = ['locked', 'visible'];

async function updateLayer(req, res, next) {
  try {
    const existing = await layersModel.getLayer(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Layer not found' });

    const { updatedAt, ...rawPatch } = req.body;
    const patch = { ...rawPatch };

    // A brush stroke in mask-edit mode re-uploads the merged mask alongside
    // the rest of the patch as multipart form-data (requirements doc,
    // Section 5.2) — everything else PATCHes as plain JSON. Multer leaves
    // req.body untouched for non-multipart requests, so form-field strings
    // only need coercion on the multipart path.
    if (req.file) {
      const relativeDir = path.join('uploads', existing.asset_id, 'masks');
      patch.maskPath = storage.saveBuffer(relativeDir, `layer_${Date.now()}.png`, req.file.buffer);
      for (const field of NUMERIC_PATCH_FIELDS) {
        if (patch[field] !== undefined) patch[field] = Number(patch[field]);
      }
      for (const field of BOOLEAN_PATCH_FIELDS) {
        if (patch[field] !== undefined) patch[field] = patch[field] === 'true' || patch[field] === true;
      }
    }

    const layer = await layersModel.updateLayer(req.params.id, patch, updatedAt);
    res.json(layer);
  } catch (err) { next(err); }
}

async function deleteLayer(req, res, next) {
  try {
    const existing = await layersModel.getLayer(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Layer not found' });
    await layersModel.deleteLayer(req.params.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

// Undo of a delete (or redo of a create) — brings a soft-deleted layer back
// with the same id and mask, rather than recreating a new row.
async function restoreLayer(req, res, next) {
  try {
    const existing = await layersModel.getLayerIncludingDeleted(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Layer not found' });
    const layer = await layersModel.restoreLayer(req.params.id);
    res.json(layer);
  } catch (err) { next(err); }
}

module.exports = { createLayer, listLayers, updateLayer, deleteLayer, restoreLayer };
