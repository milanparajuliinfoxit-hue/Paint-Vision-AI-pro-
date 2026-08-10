import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Clock, FolderKanban, PenLine, Plus, Sparkles } from 'lucide-react';
import { useProjectsList } from './useProjects';
import CreateProjectModal from './CreateProjectModal';
import StatusBadge from './statusBadge';
import ProjectCover from './ProjectCover';
import { Button } from '../../shared/ui/button';
import { formatShortDate } from '../../shared/lib/formatDate';

const STATS = [
  { key: 'total', label: 'Total projects', Icon: FolderKanban, tint: 'bg-[var(--signal)]/10 text-[var(--signal)]' },
  { key: 'inReview', label: 'In review', Icon: Clock, tint: 'bg-[var(--warning)]/10 text-[var(--warning)]' },
  { key: 'approved', label: 'Client approved', Icon: CheckCircle2, tint: 'bg-[var(--success)]/10 text-[var(--success)]' },
  { key: 'drafts', label: 'Drafts', Icon: PenLine, tint: 'bg-[var(--graphite)]/10 text-[var(--graphite-dark)]' },
];

export default function DashboardPage() {
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();
  const { data: projects = [], isLoading } = useProjectsList();
  const recent = projects.slice(0, 3);

  const counts = {
    total: projects.length,
    inReview: projects.filter((p) => p.status === 'in_review').length,
    approved: projects.filter((p) => p.status === 'client_approved').length,
    drafts: projects.filter((p) => p.status === 'draft' || !p.status).length,
  };

  return (
    <div className="p-6 sm:p-8 max-w-5xl">
      <header className="flex items-end justify-between gap-4 mb-8">
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--graphite)]">
            Overview
          </div>
          <h1 className="text-2xl">Dashboard</h1>
          <p className="mt-1.5 text-[var(--graphite)]">Pick up where you left off, or start a new project.</p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="shrink-0">
          <Plus size={16} strokeWidth={2.5} /> New project
        </Button>
      </header>

      <section className="mb-10 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {STATS.map(({ key, label, Icon, tint }) => (
          <div
            key={key}
            className="rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper-raised)] p-4 shadow-[var(--shadow-card)]"
          >
            <div className={`mb-3 grid h-9 w-9 place-items-center rounded-[var(--radius-sm)] ${tint}`}>
              <Icon size={17} strokeWidth={2} />
            </div>
            <div
              className="text-2xl font-semibold tabular-nums"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {isLoading ? '–' : counts[key]}
            </div>
            <div className="mt-0.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--graphite)]">
              {label}
            </div>
          </div>
        ))}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--graphite)]">
            Continue where you left off
          </h2>
          {!isLoading && projects.length > 3 && (
            <button
              onClick={() => navigate('/projects')}
              className="inline-flex items-center gap-1 text-xs font-medium text-[var(--signal)] hover:underline"
            >
              View all projects <ArrowRight size={13} />
            </button>
          )}
        </div>

        {isLoading && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper-raised)]">
                <div className="skeleton aspect-[4/3]" />
                <div className="space-y-2 p-4">
                  <div className="skeleton h-3 w-24" />
                  <div className="skeleton h-4 w-40" />
                  <div className="skeleton h-3 w-28" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!isLoading && recent.length === 0 && (
          <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--line)] bg-[var(--paper-raised)]/50 p-12 text-center">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-[var(--signal)]/10 text-[var(--signal)]">
              <Sparkles size={20} />
            </div>
            <div className="font-semibold">No projects yet</div>
            <p className="mx-auto mt-1 max-w-sm text-sm text-[var(--graphite)]">
              Create your first project to start visualizing paint on a photo.
            </p>
            <Button className="mt-5" size="sm" onClick={() => setShowCreate(true)}>
              <Plus size={14} strokeWidth={2.5} /> Create your first project
            </Button>
          </div>
        )}

        {!isLoading && recent.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {recent.map((p) => (
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
                  <div className="mt-3 flex items-center justify-between text-xs text-[var(--graphite)]">
                    <span>Updated {formatShortDate(p.updated_at)}</span>
                    <ArrowRight size={14} className="text-[var(--graphite)] transition-all group-hover:translate-x-0.5 group-hover:text-[var(--signal)]" />
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <CreateProjectModal
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={(project) => navigate(`/projects/${project.id}/visualize`)}
      />
    </div>
  );
}
