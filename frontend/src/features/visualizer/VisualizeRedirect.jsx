import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import CreateProjectModal from '../projects/CreateProjectModal';

// The Visualizer never opens without a project (requirements doc, Section 3,
// "Key IA rule"). Landing here with no :projectId means the URL was typed or
// bookmarked directly — send the user straight into project creation instead
// of a dead end.
export default function VisualizeRedirect() {
  const [open, setOpen] = useState(true);
  const navigate = useNavigate();

  return (
    <div className="p-8">
      <p className="text-[var(--graphite)]">The Visualizer only opens inside a project.</p>
      <CreateProjectModal
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) navigate('/projects');
        }}
        onCreated={(project) => navigate(`/projects/${project.id}/visualize`)}
      />
    </div>
  );
}
