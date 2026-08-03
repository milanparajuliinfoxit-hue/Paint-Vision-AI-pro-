import { forwardRef } from 'react';

const PRODUCT_LINES = ['tenprotect', 'brightshine', 'colorfuleco', 'jotashield', 'majestic', 'sevenprotect', 'surprised'];

// Card replaces the flat swatch grid (requirements doc, Section 6.1). This
// catalog's schema doesn't carry a "finish" or "brand" attribute on the
// paint itself (finish is chosen per-layer at application time — see
// layers.finish_override); "brand" maps to the product-line flags already
// in the schema, so the card shows those instead of fabricating fields that
// don't exist in the data.
const PaintCard = forwardRef(function PaintCard(
  { paint, selected, isFavorite, onSelect, onToggleFavorite, onMouseEnter, onMouseLeave, onKeyDown },
  ref
) {
  const lines = PRODUCT_LINES.filter((k) => paint[k]);

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`relative rounded-[var(--radius-md)] border p-2 text-left transition-colors ${
        selected ? 'border-[var(--signal)] ring-1 ring-[var(--signal)]' : 'border-[var(--line)] hover:border-[var(--graphite)]'
      }`}
    >
      <button ref={ref} onKeyDown={onKeyDown} onClick={() => onSelect(paint)} className="w-full text-left">
        <span
          className="block w-full aspect-[4/3] rounded-[var(--radius-sm)] mb-2"
          style={{ background: paint.hex_value }}
        />
        <span className="block text-sm font-medium truncate">{paint.color_name}</span>
        <span className="block text-xs text-[var(--graphite)] font-mono">{paint.color_code}</span>
        {lines.length > 0 && (
          <span className="block text-[10px] text-[var(--graphite)] mt-1 truncate">{lines.join(', ')}</span>
        )}
      </button>

      {onToggleFavorite && (
        <button
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-pressed={isFavorite}
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(paint.id); }}
          className={`absolute top-2 right-2 text-sm ${isFavorite ? 'text-[var(--warning)]' : 'text-white/70 hover:text-white'}`}
        >
          {isFavorite ? '★' : '☆'}
        </button>
      )}
    </div>
  );
});

export default PaintCard;
