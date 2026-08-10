// Pure decision logic for the paint-color-persistence rule: the currently
// selected color is an input to creating/updating a paint operation, not a
// global property that dynamically recolors existing layers. Kept
// dependency-free (no api.js/import.meta.env) so it's testable under plain
// Node, same rationale as layerCacheUtils.js.

// Whether a catalog color pick should recolor the currently active layer.
// A layer can be "active" merely because it's the implicit paint-
// continuation target left over from having just been painted — that must
// not authorize a recolor. Only a deliberate Layers/Finishes panel click
// (layerSelectedExplicitly) does.
export function canRecolorActiveLayer(activeLayer, layerSelectedExplicitly) {
  return !!activeLayer && !!layerSelectedExplicitly;
}

// Whether a mask-edit "add to mask" brush stroke should start a brand new
// layer instead of merging into the currently active one. A layer holds
// exactly one current_color_id, so a pending color that differs from the
// active layer's own stored color means a new paint operation, not a
// silent repaint of the layer's existing region. Subtract strokes never
// introduce color, so they're never gated by this.
export function isColorMismatch({ activeLayer, pendingColorId, subtract }) {
  if (subtract) return false;
  if (!activeLayer?.current_color_id || !pendingColorId) return false;
  return pendingColorId !== activeLayer.current_color_id;
}
