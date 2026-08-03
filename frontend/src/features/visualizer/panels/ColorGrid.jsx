import PaintCard from '../../catalog/PaintCard';

// Shared grid renderer for every color-browsing section (Catalog, Favorites,
// Brands, Collections) so each section only needs to supply its own filtered
// `rows` — selection, hover-preview, and favorite-toggle behavior stays
// identical everywhere a paint card appears.
export default function ColorGrid({ rows, pendingColorId, isSelected, isFavorite, onToggleFavorite, onPick, onHover, emptyMessage }) {
  if (rows.length === 0) {
    return <p className="p-3 text-xs text-[var(--graphite)]">{emptyMessage || 'No colors here yet.'}</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-2 p-2">
      {rows.map((paint) => (
        <PaintCard
          key={paint.id}
          paint={paint}
          selected={isSelected ? isSelected(paint) : pendingColorId === paint.id}
          isFavorite={isFavorite?.(paint.id)}
          onSelect={onPick}
          onToggleFavorite={onToggleFavorite}
          onMouseEnter={() => onHover?.(paint)}
          onMouseLeave={() => onHover?.(null)}
        />
      ))}
    </div>
  );
}
