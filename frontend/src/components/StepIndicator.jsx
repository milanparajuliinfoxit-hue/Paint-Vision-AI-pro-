const STEPS = ['Upload', 'Clean up', 'Select surface', 'Apply color'];

export default function StepIndicator({ current }) {
  return (
    <div style={{ display: 'flex', gap: 0, marginBottom: 24 }}>
      {STEPS.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'pending';
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              color: state === 'pending' ? 'var(--graphite)' : 'var(--ink)',
              fontWeight: state === 'active' ? 600 : 400,
            }}>
              <span style={{
                width: 22, height: 22, borderRadius: '50%', fontSize: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: state === 'pending' ? 'var(--line)' : 'var(--signal)',
                color: state === 'pending' ? 'var(--graphite)' : 'white',
              }}>
                {i + 1}
              </span>
              {label}
            </div>
            {i < STEPS.length - 1 && <div style={{ width: 32, height: 1, background: 'var(--line)', margin: '0 10px' }} />}
          </div>
        );
      })}
    </div>
  );
}
