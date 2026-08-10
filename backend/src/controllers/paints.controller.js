const paintsModel = require('../services/paints.model');
const { paintSchema } = require('../services/paints.validation');
const { asyncHandler } = require('../utils/asyncHandler');
const { conflict, notFound, HttpError } = require('../utils/httpError');

async function getPaintOrFail(id) {
  const paint = await paintsModel.getById(id);
  if (!paint) throw notFound('Paint not found');
  return paint;
}

// zod issues are part of the response body, so validation failures can't use
// the plain message-only HttpError shape.
function parsePaint(input) {
  const parsed = paintSchema.safeParse(input);
  if (!parsed.success) {
    const err = new HttpError(400, 'Validation failed');
    err.issues = parsed.error.issues;
    throw err;
  }
  return parsed.data;
}

const listPaints = asyncHandler(async (req, res) => {
  const { search, productLine, page, pageSize } = req.query;
  const result = await paintsModel.list({
    search,
    productLine,
    page: page ? Number(page) : 1,
    pageSize: pageSize ? Number(pageSize) : 25,
  });
  res.json(result);
});

const getPaint = asyncHandler(async (req, res) => {
  res.json(await getPaintOrFail(req.params.id));
});

const createPaint = asyncHandler(async (req, res) => {
  const data = parsePaint(req.body);
  const existing = await paintsModel.findByColorCode(data.color_code);
  if (existing) throw conflict(`colorCode '${data.color_code}' already exists`);
  res.status(201).json(await paintsModel.create(data));
});

const updatePaint = asyncHandler(async (req, res) => {
  const existing = await getPaintOrFail(req.params.id);
  const data = parsePaint({ ...existing, ...req.body });
  res.json(await paintsModel.update(req.params.id, data));
});

const deletePaint = asyncHandler(async (req, res) => {
  await getPaintOrFail(req.params.id);
  await paintsModel.softDelete(req.params.id);
  res.status(204).send();
});

module.exports = { listPaints, getPaint, createPaint, updatePaint, deletePaint };
