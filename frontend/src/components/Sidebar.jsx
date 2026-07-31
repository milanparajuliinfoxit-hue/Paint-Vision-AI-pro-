import { NavLink } from 'react-router-dom';

/**
 * Signature element: a vertical swatch rail on the sidebar's leading edge.
 * It shows whichever paint color is currently active in the app (selected
 * in the catalog, or applied in the visualizer) — a literal paint stick
 * resting against the counter, tying the chrome back to the product itself.
 */
export default function Sidebar({ activeColor }) {
  return (
    <aside style={styles.sidebar}>
      <div style={{ ...styles.rail, background: activeColor || 'var(--graphite-dark)' }} />
      <div style={styles.inner}>
        <div style={styles.brand}>
          <span style={styles.brandMark}>◆</span>
          <span style={styles.brandName}>Visualizer</span>
        </div>

        <nav style={styles.nav}>
          <NavLink to="/catalog" style={navStyle}>Color Catalog</NavLink>
          <NavLink to="/visualizer" style={navStyle}>Visualize</NavLink>
        </nav>

        <div style={styles.footer}>
          <div style={styles.footerLabel}>Active color</div>
          <div style={styles.footerValue} className="color-code">
            {activeColor ? activeColor.toUpperCase() : '—'}
          </div>
        </div>
      </div>
    </aside>
  );
}

function navStyle({ isActive }) {
  return {
    display: 'block',
    padding: '10px 14px',
    borderRadius: 'var(--radius-sm)',
    color: isActive ? 'white' : 'rgba(255,255,255,0.65)',
    background: isActive ? 'var(--signal)' : 'transparent',
    textDecoration: 'none',
    fontWeight: 500,
    marginBottom: 4,
  };
}

const styles = {
  sidebar: {
    width: 'var(--sidebar-width)',
    minHeight: '100vh',
    background: 'var(--ink)',
    display: 'flex',
    position: 'relative',
    flexShrink: 0,
  },
  rail: {
    width: 8,
    flexShrink: 0,
    transition: 'background 0.3s ease',
  },
  inner: {
    flex: 1,
    padding: '20px 16px',
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: 'white',
    marginBottom: 32,
    fontFamily: 'var(--font-display)',
    fontSize: 18,
  },
  brandMark: { color: 'var(--signal)' },
  brandName: { fontWeight: 600 },
  nav: { flex: 1 },
  footer: {
    borderTop: '1px solid rgba(255,255,255,0.1)',
    paddingTop: 16,
  },
  footerLabel: { color: 'rgba(255,255,255,0.45)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' },
  footerValue: { color: 'white', fontSize: 14, marginTop: 4 },
};
