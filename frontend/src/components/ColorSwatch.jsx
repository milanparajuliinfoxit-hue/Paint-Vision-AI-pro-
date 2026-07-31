export default function ColorSwatch({ hex, size = 28, onClick, selected }) {
  return (
    <button
      onClick={onClick}
      title={hex}
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        background: hex,
        border: selected ? '2px solid var(--ink)' : '1px solid var(--line)',
        boxShadow: selected ? '0 0 0 2px var(--paper-raised), 0 0 0 4px var(--signal)' : 'none',
        cursor: onClick ? 'pointer' : 'default',
        padding: 0,
      }}
    />
  );
}
