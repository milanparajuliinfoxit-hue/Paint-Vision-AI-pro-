const paintsModel = require('../services/paints.model');
const { paintSchema } = require('../services/paints.validation');

async function listPaints(req, res, next) {
  try {
    const { search, productLine, page, pageSize } = req.query;
    const result = await paintsModel.list({
      search,
      productLine,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 25,
    });
    res.json(result);
  } catch (err) { next(err); }
}

async function getPaint(req, res, next) {
  try {
    const paint = await paintsModel.getById(req.params.id);
    if (!paint) return res.status(404).json({ error: 'Paint not found' });
    res.json(paint);
  } catch (err) { next(err); }
}

async function createPaint(req, res, next) {
  try {
    const parsed = paintSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
    }
    const existing = await paintsModel.findByColorCode(parsed.data.color_code);
    if (existing) {
      return res.status(409).json({ error: `colorCode '${parsed.data.color_code}' already exists` });
    }
    const paint = await paintsModel.create(parsed.data);
    res.status(201).json(paint);
  } catch (err) { next(err); }
}

async function updatePaint(req, res, next) {
  try {
    const existing = await paintsModel.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Paint not found' });

    const parsed = paintSchema.safeParse({ ...existing, ...req.body });
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
    }
    const paint = await paintsModel.update(req.params.id, parsed.data);
    res.json(paint);
  } catch (err) { next(err); }
}

async function deletePaint(req, res, next) {
  try {
    const existing = await paintsModel.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Paint not found' });
    await paintsModel.softDelete(req.params.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

module.exports = { listPaints, getPaint, createPaint, updatePaint, deletePaint };
