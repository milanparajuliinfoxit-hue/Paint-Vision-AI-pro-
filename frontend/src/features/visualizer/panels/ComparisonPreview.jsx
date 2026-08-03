import { useRef, useState } from 'react';

// The four display modes from requirements doc Section 8, comparing any two
// rendered states. `beforeSrc`/`afterSrc` are already-rendered image URLs or
// data URIs — this component only handles the compositing/interaction.
export default function ComparisonPreview({ mode, beforeSrc, afterSrc, beforeLabel = 'Before', afterLabel = 'After' }) {
  const [sliderPct, setSliderPct] = useState(50);
  const containerRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function handlePointerMove(e) {
    if (!dragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setSliderPct(Math.min(100, Math.max(0, pct)));
  }

  if (!beforeSrc || !afterSrc) {
    return <div className="aspect-video bg-[var(--ink-soft)] rounded-[var(--radius-md)]" />;
  }

  if (mode === 'side-by-side') {
    return (
      <div className="grid grid-cols-2 gap-2">
        <Labeled label={beforeLabel} src={beforeSrc} />
        <Labeled label={afterLabel} src={afterSrc} />
      </div>
    );
  }

  if (mode === 'fade') {
    return (
      <div className="relative aspect-video rounded-[var(--radius-md)] overflow-hidden">
        <img src={beforeSrc} alt={beforeLabel} className="absolute inset-0 w-full h-full object-cover" />
        <img src={afterSrc} alt={afterLabel} className="absolute inset-0 w-full h-full object-cover" style={{ opacity: sliderPct / 100 }} />
        <input
          type="range"
          min={0} max={100} value={sliderPct}
          onChange={(e) => setSliderPct(+e.target.value)}
          className="absolute bottom-2 left-2 right-2"
          aria-label="Fade between before and after"
        />
      </div>
    );
  }

  // 'slider' and 'split' both reveal the after-image on one side of a drag
  // handle — split just parks the handle at 50% and disables dragging.
  const clipPct = mode === 'split' ? 50 : sliderPct;
  return (
    <div
      ref={containerRef}
      className="relative aspect-video rounded-[var(--radius-md)] overflow-hidden select-none"
      onPointerMove={handlePointerMove}
      onPointerUp={() => setDragging(false)}
      onPointerLeave={() => setDragging(false)}
    >
      <img src={beforeSrc} alt={beforeLabel} className="absolute inset-0 w-full h-full object-cover" />
      <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - clipPct}% 0 0)` }}>
        <img src={afterSrc} alt={afterLabel} className="absolute inset-0 w-full h-full object-cover" />
      </div>
      {mode === 'slider' && (
        <div
          onPointerDown={() => setDragging(true)}
          className="absolute top-0 bottom-0 w-1 bg-white cursor-ew-resize shadow-[0_0_0_1px_rgba(0,0,0,0.2)]"
          style={{ left: `${clipPct}%` }}
        >
          <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 left-1/2 w-6 h-6 rounded-full bg-white shadow-[var(--shadow-card)]" />
        </div>
      )}
    </div>
  );
}

function Labeled({ label, src }) {
  return (
    <div>
      <img src={src} alt={label} className="w-full aspect-video object-cover rounded-[var(--radius-md)]" />
      <div className="text-xs text-[var(--graphite)] mt-1 text-center">{label}</div>
    </div>
  );
}
