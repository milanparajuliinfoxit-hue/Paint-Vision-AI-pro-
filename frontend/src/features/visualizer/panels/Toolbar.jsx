import { useEffect } from 'react';
import { TOOL_GROUPS, toolByShortcut } from '../tools/toolDefs';
import { useVisualizerStore } from '../store/visualizerStore';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '../../../shared/ui/tooltip';

// Vertical floating toolbar: Selection -> Paint -> Utility (requirements
// doc, Section 5.1). Every tool is keyboard-reachable via its shortcut, not
// just mouse click (Section 12).
export default function Toolbar() {
  const activeTool = useVisualizerStore((s) => s.activeTool);
  const setActiveTool = useVisualizerStore((s) => s.setActiveTool);
  const imageLocked = useVisualizerStore((s) => s.imageLocked);
  const setImageLocked = useVisualizerStore((s) => s.setImageLocked);
  const imageVisible = useVisualizerStore((s) => s.imageVisible);
  const setImageVisible = useVisualizerStore((s) => s.setImageVisible);
  const requestFit = useVisualizerStore((s) => s.requestFit);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey) return;
      const tool = toolByShortcut(e.key);
      if (tool) setActiveTool(tool.id);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setActiveTool]);

  const viewButtons = [
    { id: 'fit', label: 'Fit to screen', glyph: '⤢', onClick: requestFit, active: false },
    { id: 'lock', label: imageLocked ? 'Unlock photo' : 'Lock photo', glyph: imageLocked ? '🔓' : '🔒', onClick: () => setImageLocked(!imageLocked), active: imageLocked },
    { id: 'hide', label: imageVisible ? 'Hide photo' : 'Show photo', glyph: imageVisible ? '👁' : '🚫', onClick: () => setImageVisible(!imageVisible), active: !imageVisible },
  ];

  return (
    <TooltipProvider delayDuration={300}>
      <div
        role="toolbar"
        aria-label="Canvas tools"
        className="flex flex-col gap-3 bg-[var(--ink)] rounded-[var(--radius-md)] p-2 shadow-[var(--shadow-card)]"
      >
        {TOOL_GROUPS.map((group, gi) => (
          <div key={group.label} className="flex flex-col gap-1">
            {gi > 0 && <div className="h-px bg-white/10 mb-1" />}
            {group.tools.map((t) => (
              <Tooltip key={t.id}>
                <TooltipTrigger asChild>
                  <button
                    aria-label={`${t.label} (${t.shortcut.toUpperCase()})`}
                    aria-pressed={activeTool === t.id}
                    onClick={() => setActiveTool(t.id)}
                    className={`h-9 w-9 rounded-[var(--radius-sm)] text-base flex items-center justify-center transition-colors ${
                      activeTool === t.id ? 'bg-[var(--signal)] text-white' : 'text-white/70 hover:bg-white/10'
                    }`}
                  >
                    {t.glyph}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{t.label} · {t.shortcut.toUpperCase()}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        ))}

        <div className="h-px bg-white/10" />
        <div className="flex flex-col gap-1">
          {viewButtons.map((b) => (
            <Tooltip key={b.id}>
              <TooltipTrigger asChild>
                <button
                  aria-label={b.label}
                  aria-pressed={b.active}
                  onClick={b.onClick}
                  className={`h-9 w-9 rounded-[var(--radius-sm)] text-base flex items-center justify-center transition-colors ${
                    b.active ? 'bg-white/20 text-white' : 'text-white/70 hover:bg-white/10'
                  }`}
                >
                  {b.glyph}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{b.label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}
