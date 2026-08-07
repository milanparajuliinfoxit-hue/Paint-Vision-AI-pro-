const { z } = require('zod');

const rgbByte = z.coerce.number().int().min(0).max(255);
const flag = z.union([z.boolean(), z.coerce.number()]).transform((v) => !!v).optional();

const paintSchema = z.object({
  s_id: z.coerce.number().int().optional().nullable(),
  color_code: z.string().trim().min(1, 'colorCode is required').max(50),
  color_name: z.string().trim().min(1, 'colorName is required').max(150),
  tenprotect: flag,
  brightshine: flag,
  colorfuleco: flag,
  jotashield: flag,
  majestic: flag,
  sevenprotect: flag,
  surprised: flag,
  r_value: rgbByte,
  g_value: rgbByte,
  b_value: rgbByte,
});

// Same shape, but tolerant of the exact Excel header names from the source file.
//
// Resolved: the source file's `id` column is the exporting system's own
// auto-increment row number, not a stable product identifier — reusing it
// as our PK or as `s_id` would collide with (or be shadowed by) this app's
// own auto-increment `paints.id` on every re-import. `s_id` is the real,
// stable source-product identifier and is the only one we import;
// `id` is intentionally dropped (mapRow skips it below).
const EXCEL_COLUMN_MAP = {
  id: 's_id_or_id', // intentionally ignored — see note above
  s_id: 's_id',
  colorCode: 'color_code',
  colorName: 'color_name',
  tenprotect: 'tenprotect',
  brightshine: 'brightshine',
  colorfuleco: 'colorfuleco',
  jotashield: 'jotashield',
  majestic: 'majestic',
  sevenprotect: 'sevenprotect',
  surprised: 'surprised',
  rValue: 'r_value',
  gValue: 'g_value',
  bValue: 'b_value',
};

module.exports = { paintSchema, EXCEL_COLUMN_MAP };
