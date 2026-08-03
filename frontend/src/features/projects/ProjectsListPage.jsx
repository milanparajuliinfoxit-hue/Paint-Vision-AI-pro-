import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, LayoutGrid, List, Plus, Search, Sparkles } from 'lucide-react';
import { useProjectsList } from './useProjects';
import CreateProjectModal from './CreateProjectModal';
import StatusBadge from './statusBadge';
import ProjectCover from './ProjectCover';
import { Button } from '../../shared/ui/button';
import { cn } from '../../shared/lib/cn';

const STATUSES = ['draft', 'in_review', 'client_approved', 'archived'];

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  ...STATUSES.map((s) => ({ value: s, label: s.replace('_', ' ') })),
];

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ProjectsListPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [view, setView] = useState('grid');
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();

  const { data: projects = [], isLoading } = useProjectsList({
    ...(search ? { search } : {}),
    ...(status ? { status } : {}),
  });

  const hasFilters = Boolean(search || status);

  return (
    <div className="p-6 sm:p-8 max-w-6xl">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--graphite)]">
            Workspace
          </div>
          <h1 className="text-2xl">Projects</h1>
          <p className="mt-1.5 text-[var(--graphite)]">
            {isLoading ? 'Loading projects…' : `${projects.length} project${projects.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="shrink-0">
          <Plus size={16} strokeWidth={2.5} /> New project
        </Button>
      </header>

      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative max-w-sm flex-1">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--graphite)]"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by client or project name…"
            className="w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper-raised)] py-2 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-[var(--graphite)] focus:border-[var(--signal)]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value || 'all'}
              onClick={() => setStatus(f.value)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                status === f.value
                  ? 'border-transparent bg-[var(--signal)] text-white'
                  : 'border-[var(--line)] bg-[var(--paper-raised)] text-[var(--graphite)] hover:border-[var(--graphite)] hover:text-[var(--ink)]'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex overflow-hidden rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper-raised)]">
          <button
            onClick={() => setView('grid')}
            aria-label="Grid view"
            aria-pressed={view === 'grid'}
            className={cn(
              'flex items-center justify-center px-3 py-2 transition-colors',
              view === 'grid' ? 'bg-[var(--signal)] text-white' : 'text-[var(--graphite)] hover:bg-[var(--paper)]'
            )}
          >
            <LayoutGrid size={15} />
          </button>
          <div className="w-px bg-[var(--line)]" />
          <button
            onClick={() => setView('table')}
            aria-label="Table view"
            aria-pressed={view === 'table'}
            className={cn(
              'flex items-center justify-center px-3 py-2 transition-colors',
              view === 'table' ? 'bg-[var(--signal)] text-white' : 'text-[var(--graphite)] hover:bg-[var(--paper)]'
            )}
          >
            <List size={15} />
          </button>
        </div>
      </div>

      {isLoading && (
        <div className={cn('grid gap-4', view === 'table' ? 'grid-cols-1' : 'grid-cols-[repeat(auto-fill,minmax(220px,1fr))]')}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper-raised)]">
              <div className="skeleton aspect-[4/3]" />
              <div className="space-y-2 p-4">
                <div className="skeleton h-3 w-20" />
                <div className="skeleton h-4 w-36" />
                <div className="skeleton h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!isLoading && projects.length === 0 && (
        <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--line)] bg-[var(--paper-raised)]/50 p-12 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-[var(--signal)]/10 text-[var(--signal)]">
            <Sparkles size={20} />
          </div>
          <div className="font-semibold">{hasFilters ? 'No matching projects' : 'No projects yet'}</div>
          <p className="mx-auto mt-1 max-w-sm text-sm text-[var(--graphite)]">
            {hasFilters
              ? 'Try adjusting your search or status filter, or create a new project.'
              : 'Create one to start a paint visualization.'}
          </p>
          {hasFilters ? (
            <Button className="mt-5" size="sm" variant="secondary" onClick={() => { setSearch(''); setStatus(''); }}>
              Clear filters
            </Button>
          ) : (
            <Button className="mt-5" size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={14} strokeWidth={2.5} /> Create your first project
            </Button>
          )}
        </div>
      )}

      {!isLoading && projects.length > 0 && view === 'grid' && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => navigate(`/projects/${p.id}/visualize`)}
              className="group overflow-hidden rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper-raised)] text-left shadow-[var(--shadow-card)] transition-all hover:-translate-y-0.5 hover:border-[var(--signal)] hover:shadow-[0_8px_24px_rgba(23,24,28,0.12)]"
            >
              <div className="relative">
                <ProjectCover project={p} />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/30 to-transparent" />
                <div className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-white/90 text-[var(--ink)] opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                  <ArrowRight size={14} className="-rotate-45" />
                </div>
              </div>
              <div className="p-4">
                <StatusBadge status={p.status} />
                <div className="mt-2 truncate font-semibold">{p.name || p.client_name}</div>
                <div className="mt-0.5 truncate text-sm text-[var(--graphite)]">{p.client_name}</div>
                <div className="mt-3 text-xs text-[var(--graphite)]">
                  Updated {formatDate(p.updated_at)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {!isLoading && projects.length > 0 && view === 'table' && (
        <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper-raised)] shadow-[var(--shadow-card)]">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--paper)] text-left text-[11px] uppercase tracking-[0.1em] text-[var(--graphite)]">
                <th className="py-2.5 pl-4 pr-4 font-medium">Project</th>
                <th className="py-2.5 pr-4 font-medium">Client</th>
                <th className="py-2.5 pr-4 font-medium">Status</th>
                <th className="py-2.5 pr-4 font-medium">Updated</th>
                <th className="py-2.5 pr-4 text-right font-medium">Open</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => navigate(`/projects/${p.id}/visualize`)}
                  className="group cursor-pointer border-b border-[var(--line)] transition-colors last:border-b-0 hover:bg-[var(--paper)]"
                >
                  <td className="py-3 pl-4 pr-4">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-14 shrink-0 overflow-hidden rounded-[var(--radius-sm)] bg-[var(--paper)]">
                        <ProjectCover project={p} />
                      </div>
                      <span className="font-medium">{p.name || p.client_name}</span>
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-[var(--graphite)]">{p.client_name}</td>
                  <td className="py-3 pr-4"><StatusBadge status={p.status} /></td>
                  <td className="py-3 pr-4 text-[var(--graphite)]">{formatDate(p.updated_at)}</td>
                  <td className="py-3 pr-4 text-right">
                    <ArrowRight
                      size={15}
                      className="ml-auto text-[var(--graphite)] opacity-0 transition-all group-hover:translate-x-0.5 group-hover:text-[var(--signal)] group-hover:opacity-100"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateProjectModal
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={(project) => navigate(`/projects/${project.id}/visualize`)}
      />
    </div>
  );
}
