import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Droplet,
  FolderKanban,
  LayoutDashboard,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from 'lucide-react';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '../shared/ui/tooltip';
import { useMediaQuery } from '../shared/lib/useMediaQuery';
import { cn } from '../shared/lib/cn';
import CreateProjectModal from '../features/projects/CreateProjectModal';

const COLLAPSED_KEY = 'pv:sidebar-collapsed';

const SECTIONS = [
  {
    label: 'Workspace',
    items: [
      { to: '/dashboard', label: 'Dashboard', Icon: LayoutDashboard },
      { to: '/projects', label: 'Projects', Icon: FolderKanban },
    ],
  },
  {
    label: 'Library',
    items: [{ to: '/catalog', label: 'Paint Catalog', Icon: Palette }],
  },
];

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Icon-rail collapse (ChatGPT/VS Code pattern): expanded state shows brand,
 * name and subtitle with the toggle at the top-right. When collapsed, the
 * brand mark is centered on its own with nothing competing for the narrow
 * width, and the expand control moves to a compact button at the bottom of
 * the rail. Labels fade and slide out with the width instead of popping.
 */
export default function Sidebar() {
  const [userCollapsed, setUserCollapsed] = useState(readCollapsed);
  const [showCreate, setShowCreate] = useState(false);
  const forceCompact = useMediaQuery('(max-width: 900px)');
  const collapsed = forceCompact || userCollapsed;
  const navigate = useNavigate();

  function toggleCollapsed() {
    setUserCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch { /* ignore */ }
      return next;
    });
  }

  const logo = (
    <div
      className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-white"
      style={{ background: 'linear-gradient(135deg, var(--signal), var(--signal-dark))', boxShadow: '0 6px 16px rgba(47, 93, 138, 0.35)' }}
    >
      <Droplet size={18} strokeWidth={2} />
    </div>
  );

  return (
    <TooltipProvider delayDuration={250}>
      <aside
        className="relative flex h-full min-h-full shrink-0 overflow-hidden bg-[var(--ink)]"
        style={{
          width: collapsed ? 72 : 'var(--sidebar-width)',
          transition: 'width 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <div className="w-2 shrink-0 bg-[var(--graphite-dark)]" />

        <div className="flex h-full min-w-0 flex-1 flex-col px-3 py-4">
          <div className="flex items-center justify-between gap-2">
            <div className={cn('flex min-w-0 items-center gap-2.5', collapsed && 'flex-1 justify-center')}>
              {logo}
              <div
                className={cn(
                  'overflow-hidden whitespace-nowrap transition-all duration-300 ease-out',
                  collapsed ? 'max-w-0 opacity-0' : 'max-w-36 opacity-100'
                )}
              >
                <div
                  className="truncate text-[15px] font-semibold leading-tight text-white"
                  style={{ fontFamily: 'var(--font-display)' }}
                >
                  Visualizer
                </div>
                <div className="truncate text-[10px] font-medium uppercase leading-tight tracking-[0.14em] text-white/35">
                  Paint Studio
                </div>
              </div>
            </div>

            {!forceCompact && !collapsed && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggleCollapsed}
                    aria-label="Collapse sidebar"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-white/[0.06] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <PanelLeftClose size={17} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Collapse sidebar</TooltipContent>
              </Tooltip>
            )}
          </div>

          <div className={cn('mt-5', collapsed && 'mt-4')}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setShowCreate(true)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-[13px] font-semibold text-white',
                    'bg-[var(--signal)] transition-colors hover:bg-[var(--signal-dark)] active:scale-[0.98]',
                    collapsed && 'justify-center px-0'
                  )}
                >
                  <Plus size={16} strokeWidth={2.5} />
                  {!collapsed && 'New project'}
                </button>
              </TooltipTrigger>
              {collapsed && <TooltipContent side="right">New project</TooltipContent>}
            </Tooltip>
          </div>

          <nav className="mt-5 flex-1 overflow-y-auto">
            {SECTIONS.map((section) => (
              <div key={section.label} className="mb-1">
                {collapsed ? (
                  <div className="mx-1 mb-2 mt-2 h-px bg-white/10" />
                ) : (
                  <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">
                    {section.label}
                  </div>
                )}
                <ul className="flex flex-col gap-0.5">
                  {section.items.map(({ to, label, Icon }) => {
                    const link = (
                      <NavLink to={to} className="block">
                        {({ isActive }) => (
                          <span
                            className={cn(
                              'group relative flex items-center gap-2.5 rounded-[var(--radius-sm)] py-2 text-[13px] font-medium transition-colors',
                              collapsed ? 'justify-center px-0' : 'px-2.5',
                              isActive
                                ? 'text-white'
                                : 'text-white/60 hover:bg-white/[0.06] hover:text-white'
                            )}
                            style={
                              isActive
                                ? { background: 'linear-gradient(90deg, rgba(47, 93, 138, 0.45), rgba(47, 93, 138, 0.12))' }
                                : undefined
                            }
                          >
                            {isActive && (
                              <span className="absolute left-0 top-1/2 h-[18px] w-[3px] -translate-y-1/2 rounded-full bg-[var(--signal)] shadow-[0_0_10px_rgba(47,93,138,0.9)]" />
                            )}
                            <Icon
                              size={17}
                              strokeWidth={2}
                              className={cn(
                                'shrink-0 transition-colors',
                                isActive ? 'text-[#b9d3ee]' : 'text-white/55 group-hover:text-white'
                              )}
                            />
                            <span
                              className={cn(
                                'block overflow-hidden whitespace-nowrap transition-all duration-200 ease-out',
                                collapsed ? 'max-w-0 translate-x-1.5 opacity-0' : 'max-w-44 translate-x-0 opacity-100'
                              )}
                            >
                              <span className="block truncate">{label}</span>
                            </span>
                          </span>
                        )}
                      </NavLink>
                    );
                    return (
                      <li key={to}>
                        {collapsed ? (
                          <Tooltip>
                            <TooltipTrigger asChild>{link}</TooltipTrigger>
                            <TooltipContent side="right">{label}</TooltipContent>
                          </Tooltip>
                        ) : (
                          link
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          {!forceCompact && collapsed && (
            <div className="mt-3 flex justify-center">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggleCollapsed}
                    aria-label="Expand sidebar"
                    className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] bg-white/[0.06] text-white/75 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <PanelLeftOpen size={17} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Expand sidebar</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>

        <CreateProjectModal
          open={showCreate}
          onOpenChange={setShowCreate}
          onCreated={(project) => navigate(`/projects/${project.id}/visualize`)}
        />
      </aside>
    </TooltipProvider>
  );
}
