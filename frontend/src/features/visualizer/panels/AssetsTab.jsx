import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  useAssetsList, useUploadAsset, useCleanAsset, useRenameAsset, useDeleteAsset, useDuplicateAsset,
} from '../hooks/useAssets';
import { useLayersList } from '../hooks/useLayers';
import { useAssetAnalysis } from '../hooks/useAiAnalysis';
import { useStartAiPipeline } from '../hooks/useAiPipeline';
import { useApplyConcept, useConcepts } from '../hooks/useConcepts';
import { assets as assetsApi, exportsApi } from '../../../shared/lib/api';
import { Button } from '../../../shared/ui/button';
import { useToast } from '../../../shared/ui/toast';
import { useVisualizerStore } from '../store/visualizerStore';
import { ConfirmDialog, InputDialog } from '../../../shared/ui/confirmDialog';

// Broken/corrupt image files must be visible, not silently blank — a failed
// load renders a clear placeholder so "my photo disappeared" never happens
// again (Phase 1 hardening of the asset list).
function AssetThumb({ url }) {
  const [error, setError] = useState(false);
  if (error) {
    return (
      <div className="w-full h-24 rounded-[var(--radius-sm)] mb-2 flex items-center justify-center bg-[var(--paper)] text-[var(--danger)]">
        <span className="text-xs">Unreadable file</span>
      </div>
    );
  }
  return <img src={url} alt="" onError={() => setError(true)} className="w-full h-24 object-cover rounded-[var(--radius-sm)] mb-2" />;
}

function Section({ title, count, defaultOpen = true, children }) {
  return (
    <details open={defaultOpen} className="group">
      <summary className="flex items-center justify-between cursor-pointer text-[11px] uppercase tracking-wide text-[var(--graphite)] py-1.5 select-none">
        <span>{title}</span>
        <span className="text-[10px]">{count}</span>
      </summary>
      <div className="pb-2">{children}</div>
    </details>
  );
}

export default function AssetsTab({ projectId, activeAssetId, onSelectAsset, width, height }) {
  const fileInputRef = useRef(null);
  const setCompareState = useVisualizerStore((s) => s.setCompareState);
  const { data: assetList = [] } = useAssetsList(projectId);
  const uploadAsset = useUploadAsset(projectId);
  const startAiPipeline = useStartAiPipeline();
  const cleanAsset = useCleanAsset(projectId);
  const renameAsset = useRenameAsset(projectId);
  const deleteAsset = useDeleteAsset(projectId);
  const duplicateAsset = useDuplicateAsset(projectId);
  const { data: layerList = [] } = useLayersList(activeAssetId);
  const { data: conceptList = [] } = useConcepts(projectId);
  const { data: analysis } = useAssetAnalysis(activeAssetId);
  const { applyConcept } = useApplyConcept(projectId, activeAssetId, { width, height });
  const { data: exportList = [] } = useQuery({
    queryKey: ['exports', projectId],
    queryFn: () => exportsApi.list(projectId),
    enabled: !!projectId,
  });
  const showToast = useToast();

  const [renamingAsset, setRenamingAsset] = useState(null); // asset object or null
  const [deletingAsset, setDeletingAsset] = useState(null);

  const surfacesByClass = new Map((analysis?.surfaces || []).map((s) => [s.class_key, s]));

  async function handleApplyConcept(concept) {
    try {
      if (!analysis?.analyzed) {
        showToast('Run AI analysis on this photo first — concepts need the detected surfaces.', { variant: 'danger' });
        return;
      }
      const layer = await applyConcept(concept, surfacesByClass);
      showToast(layer ? `Applied "${concept.name}" as editable layers.` : 'Nothing to apply — no paintable surfaces match this photo.');
    } catch (err) {
      showToast(err.message || 'Could not apply concept.', { variant: 'danger' });
    }
  }

  const cleanedAssets = assetList.filter((a) => a.cleaned_path);
  const masksForActiveAsset = layerList.filter((l) => l.mask_path);

  async function handleFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const asset = await uploadAsset.mutateAsync(file);
      onSelectAsset(asset.id);
      // Fire the autonomous pipeline (house-understanding -> schemes) right
      // after upload instead of waiting for a manual "Analyze" click. Not
      // awaited — the pipeline runs server-side and the dealer keeps working;
      // AiPipelineStatusBar (polling ai/status) surfaces progress. A failure
      // to *start* it (e.g. a network blip) isn't an upload failure and
      // isn't shown as one — the "Try again" affordance covers recovery.
      startAiPipeline.mutate({ assetId: asset.id });
    } catch (err) {
      showToast(`Upload failed: ${err.message}`, { variant: 'danger' });
    }
    e.target.value = '';
  }

  async function handleCleanup(assetId) {
    try {
      await cleanAsset.mutateAsync({ assetId });
      showToast('Cleanup complete.');
    } catch (err) {
      showToast(`Cleanup failed: ${err.message} — you can keep working with the original photo.`, { variant: 'danger' });
    }
  }

  async function handleRename(asset, label) {
    try {
      await renameAsset.mutateAsync({ assetId: asset.id, label: label.trim() });
    } catch (err) {
      showToast(`Rename failed: ${err.message}`, { variant: 'danger' });
    }
  }

  async function handleDuplicate(asset) {
    try {
      const copy = await duplicateAsset.mutateAsync(asset.id);
      showToast('Photo duplicated.');
      onSelectAsset(copy.id);
    } catch (err) {
      showToast(`Duplicate failed: ${err.message}`, { variant: 'danger' });
    }
  }

  async function handleDelete(asset) {
    try {
      await deleteAsset.mutateAsync(asset.id);
      if (activeAssetId === asset.id) onSelectAsset(null);
      showToast('Photo deleted.');
    } catch (err) {
      showToast(`Delete failed: ${err.message}`, { variant: 'danger' });
    }
  }

  function AssetRow({ asset, previewPath, previewKind }) {
    return (
      <div
        className={`rounded-[var(--radius-sm)] border p-2 ${activeAssetId === asset.id ? 'border-[var(--signal)]' : 'border-[var(--line)]'}`}
      >
        <button
          onClick={() => { onSelectAsset(asset.id); setCompareState(previewKind); }}
          className="w-full text-left"
        >
          <AssetThumb url={assetsApi.fileUrl(previewPath)} />
        </button>
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className="truncate font-medium">{asset.label || (previewKind === 'cleaned' ? 'Cleaned' : 'Original')}</span>
          {asset.status === 'cleaning' && <span className="text-[var(--graphite)] shrink-0 ml-1">Cleaning…</span>}
          {asset.status === 'failed' && <span className="text-[var(--danger)] shrink-0 ml-1">Failed</span>}
        </div>
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
          {!asset.cleaned_path && asset.status !== 'cleaning' && (
            <button
              className="text-[var(--signal)] hover:underline"
              title="If this photo has been analyzed, automatically removes detected trees, cars, people, and fences — house surfaces are never touched."
              onClick={() => handleCleanup(asset.id)}
            >
              Run AI cleanup
            </button>
          )}
          <button className="text-[var(--graphite)] hover:underline" onClick={() => setRenamingAsset(asset)}>Rename</button>
          <button className="text-[var(--graphite)] hover:underline" onClick={() => handleDuplicate(asset)}>Duplicate</button>
          <button className="text-[var(--danger)] hover:underline" onClick={() => setDeletingAsset(asset)}>Delete</button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 flex flex-col gap-1 h-full overflow-y-auto">
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
      <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadAsset.isPending} className="mb-2">
        {uploadAsset.isPending ? 'Uploading…' : '+ Upload photo'}
      </Button>

      <Section title="Originals" count={assetList.length}>
        {assetList.length === 0 ? (
          <p className="text-xs text-[var(--graphite)] px-1">No photos yet. Upload one to start visualizing.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {assetList.map((asset) => <AssetRow key={asset.id} asset={asset} previewPath={asset.original_path} previewKind="original" />)}
          </div>
        )}
      </Section>

      <Section title="Cleaned" count={cleanedAssets.length} defaultOpen={false}>
        {cleanedAssets.length === 0 ? (
          <p className="text-xs text-[var(--graphite)] px-1">Run AI cleanup on a photo to see its cleaned version here.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {cleanedAssets.map((asset) => <AssetRow key={asset.id} asset={asset} previewPath={asset.cleaned_path} previewKind="cleaned" />)}
          </div>
        )}
      </Section>

      <Section title="Masks (current photo)" count={masksForActiveAsset.length} defaultOpen={false}>
        {masksForActiveAsset.length === 0 ? (
          <p className="text-xs text-[var(--graphite)] px-1">No masked layers on this photo yet — use a selection tool on the canvas.</p>
        ) : (
          <ul className="flex flex-col gap-1 px-1">
            {masksForActiveAsset.map((layer) => (
              <li key={layer.id} className="flex items-center gap-2 text-xs">
                <img src={assetsApi.fileUrl(layer.mask_path)} alt="" className="w-6 h-6 rounded-[var(--radius-sm)] border border-[var(--line)] object-cover" />
                <span className="truncate">{layer.name}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Painted (saved looks)" count={conceptList.length} defaultOpen={false}>
        {conceptList.length === 0 ? (
          <p className="text-xs text-[var(--graphite)] px-1">
            Save a scheme from the AI Schemes tab to see painted looks here — each one re-applies as
            real, editable layers on any analyzed photo.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 px-1">
            {conceptList.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-xs">
                {c.thumbnail_path && (
                  <img src={assetsApi.fileUrl(c.thumbnail_path)} alt="" className="w-8 h-8 rounded-[var(--radius-sm)] border border-[var(--line)] object-cover shrink-0" />
                )}
                <span className="truncate flex-1">{c.name}</span>
                <button className="text-[var(--signal)] hover:underline shrink-0" onClick={() => handleApplyConcept(c)}>
                  Apply
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Exports" count={exportList.length} defaultOpen={false}>
        {exportList.length === 0 ? (
          <p className="text-xs text-[var(--graphite)] px-1">No exports yet — use Export in the inspector to generate one.</p>
        ) : (
          <ul className="flex flex-col gap-1 px-1">
            {exportList.map((job) => (
              <li key={job.id} className="flex items-center justify-between text-xs">
                <span className="truncate">{job.format} · {job.status}</span>
                {job.file_path && job.status === 'ready' && (
                  <a href={assetsApi.fileUrl(job.file_path)} target="_blank" rel="noreferrer" className="text-[var(--signal)] hover:underline shrink-0 ml-2">
                    Open
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <InputDialog
        open={!!renamingAsset}
        onOpenChange={(open) => !open && setRenamingAsset(null)}
        title="Rename photo"
        label="Name"
        defaultValue={renamingAsset?.label || (renamingAsset?.cleaned_path ? 'Cleaned' : 'Original')}
        confirmLabel="Save"
        onConfirm={(label) => { handleRename(renamingAsset, label); setRenamingAsset(null); }}
      />

      <ConfirmDialog
        open={!!deletingAsset}
        onOpenChange={(open) => !open && setDeletingAsset(null)}
        title={`Delete "${deletingAsset?.label || (deletingAsset?.cleaned_path ? 'Cleaned' : 'Original')}"?`}
        description="This removes the photo and its layers, and cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => { handleDelete(deletingAsset); setDeletingAsset(null); }}
      />
    </div>
  );
}
