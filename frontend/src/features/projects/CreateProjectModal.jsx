import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../../shared/ui/dialog';
import { Button } from '../../shared/ui/button';
import { useCreateProject } from './useProjects';
import { useToast } from '../../shared/ui/toast';

// Every canvas session is scoped to a Project — this is the one required
// gate before a photo can be uploaded (requirements doc, Section 3): a
// client name, nothing else, so it never blocks a rep mid-visit.
export default function CreateProjectModal({ open, onOpenChange, onCreated }) {
  const [clientName, setClientName] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const createProject = useCreateProject();
  const showToast = useToast();

  async function handleSubmit(e) {
    e.preventDefault();
    if (!clientName.trim()) {
      setError('Client name is required.');
      return;
    }
    setError(null);
    try {
      const project = await createProject.mutateAsync({
        clientName: clientName.trim(),
        name: name.trim() || null,
      });
      showToast(`Project created for ${project.client_name}.`);
      setClientName('');
      setName('');
      onOpenChange(false);
      onCreated?.(project);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent open={open}>
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>
          Every visualization belongs to a client project. Client name is the only thing required to get started.
        </DialogDescription>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Client name *</span>
            <input
              autoFocus
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              className="rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2 text-sm"
              placeholder="J. Smith"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Project name (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2 text-sm"
              placeholder="Smith Residence — Exterior"
            />
          </label>
          {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
          <div className="flex gap-2 justify-end mt-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createProject.isPending}>
              {createProject.isPending ? 'Creating…' : 'Create project'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
