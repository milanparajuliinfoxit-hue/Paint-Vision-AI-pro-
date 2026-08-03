import { useState } from 'react';
import { assets as assetsApi } from '../../shared/lib/api';

// Renders a project card's thumbnail from cover_original_path/cover_cleaned_path
// (joined server-side in projects.model.js so list pages don't need an extra
// fetch per card). Falls back to a placeholder for projects with no photos
// yet, or if the file fails to load.
export default function ProjectCover({ project }) {
  const [error, setError] = useState(false);
  const previewPath = project.cover_cleaned_path || project.cover_original_path;

  if (!previewPath || error) {
    return (
      <div className="w-full aspect-[4/3] flex items-center justify-center bg-[var(--paper)] text-[var(--graphite)]">
        <span className="text-xs">No photo yet</span>
      </div>
    );
  }

  return (
    <img
      src={assetsApi.fileUrl(previewPath)}
      alt=""
      onError={() => setError(true)}
      className="w-full aspect-[4/3] object-cover"
    />
  );
}
