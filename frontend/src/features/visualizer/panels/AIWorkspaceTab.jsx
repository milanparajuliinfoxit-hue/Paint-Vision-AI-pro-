import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Sparkles, Wand2, Eraser, Palette, MessageSquare, RotateCcw, Layers as LayersIcon, History,
} from 'lucide-react';
import { useAiMeta, useAssetAnalysis } from '../hooks/useAiAnalysis';
import { useApplySurface } from '../hooks/useApplySurface';
import { useCatalogList } from '../../catalog/useCatalogList';
import { matchSurfacesForCategory } from '../lib/categorySurfaceMap';
import {
  useGenerateVisualization, useVisualizationStatus, useVisualizationsList,
  useRequestIsolation, useRequestObjectRemoval,
} from '../hooks/useVisualization';
import { useToast } from '../../../shared/ui/toast';
import { Button } from '../../../shared/ui/button';
import { cn } from '../../../shared/lib/cn';
import InlineColorPicker from '../components/InlineColorPicker';
import { assets as assetsApi } from '../../../shared/lib/api';

const MAX_INTENT_LENGTH = 500;

const TASKS = [
  { id: 'prepare_house', label: 'Prepare House', Icon: Wand2, description: 'Remove clutter, distractions and unrelated objects around the house — keeps the architecture exactly as photographed.' },
  { id: 'remove_objects', label: 'Remove Objects', Icon: Eraser, description: 'Tell the AI exactly what to remove (e.g. "remove the people and the ladder").' },
  { id: 'visualize_paint', label: 'Visualize Paint', Icon: Palette, description: 'Assign catalog colors to the house and generate a photorealistic preview.' },
  { id: 'custom', label: 'Custom Instruction', Icon: MessageSquare, description: 'Describe what you want in your own words — colors below still come from the catalog.' },
];

const TERMINAL = new Set(['ready', 'failed']);

/**
 * The primary Gemini-first AI workspace (migration governing brief §4/§5):
 * "I have this house photo. I want to prepare it. I want to remove
 * distractions. I want these parts painted with these catalog colors. Make
 * me a realistic visualization. Let me refine it." — no segmentation run is
 * ever required before any of this works; catalog color assignment uses
 * the fixed architecturalCategories vocabulary from GET /api/meta, not
 * detected_surfaces. Every operation (prepare/remove/paint/change-color)
 * creates one row in the same revision timeline (ai_visualizations,
 * task_type + parent_revision_id), rendered below as Original/Prepared/
 * Current + a full history strip — this is the "revision lineage" the
 * brief requires (§13), not a single mutable "the current image" slot.
 */
export default function AIWorkspaceTab({ projectId, assetId, asset, width, height }) {
  const showToast = useToast();
  const queryClient = useQueryClient();
  const { data: aiMeta } = useAiMeta();
  const categories = aiMeta?.architecturalCategories || [];
  const visualizationReady = aiMeta?.ai?.visualization?.enabled && !!aiMeta?.ai?.visualization?.provider;
  const isolationReady = aiMeta?.ai?.isolation?.enabled && !!aiMeta?.ai?.isolation?.provider;

  const { data: revisions = [] } = useVisualizationsList(assetId);
  const { data: analysis } = useAssetAnalysis(assetId);
  const { applySurface } = useApplySurface(projectId, assetId, { width, height });
  // The persisted surfaceColorPlan only stores {surfaceKey, paintId} — the
  // catalog is the source of truth for name/hex (governing brief §24), so
  // "Edit Colors" resolves ids back through the same catalog list every
  // other picker uses, not a second cached copy of paint details.
  const { data: catalogData } = useCatalogList({ pageSize: 2000 });
  const paintsById = useMemo(() => {
    const map = new Map();
    for (const p of catalogData?.rows || []) map.set(p.id, p);
    return map;
  }, [catalogData]);

  const requestIsolation = useRequestIsolation(assetId);
  const requestRemoval = useRequestObjectRemoval(assetId);
  const generateViz = useGenerateVisualization(assetId);

  const [selectedTask, setSelectedTask] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [colorPlan, setColorPlan] = useState({}); // categoryKey -> paint
  const [activeRevisionId, setActiveRevisionId] = useState(null);
  const [changeColorSourceId, setChangeColorSourceId] = useState(null); // revision being re-colored
  const [viewMode, setViewMode] = useState('current'); // 'original' | 'prepared' | 'current'

  const { data: activeRevision } = useVisualizationStatus(assetId, activeRevisionId);
  const busy = requestIsolation.isPending || requestRemoval.isPending || generateViz.isPending
    || (activeRevision && !TERMINAL.has(activeRevision.status));

  // Once the in-flight generation reaches a terminal state, stop treating it
  // as "active" for button-disabling purposes, and if it changed
  // assets.cleaned_path (prepare_house/remove_objects on success), refresh
  // the per-project assets list so the canvas picks up the new photo.
  useEffect(() => {
    if (activeRevision?.status === 'ready' &&
        (activeRevision.task_type === 'prepare_house' || activeRevision.task_type === 'remove_objects')) {
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'assets' });
    }
  }, [activeRevision?.status, activeRevision?.task_type, queryClient]);

  const readyRevisions = useMemo(() => revisions.filter((r) => r.status === 'ready'), [revisions]);
  const latestReady = readyRevisions[0] || null; // list is newest-first
  const latestPrepared = readyRevisions.find((r) => r.task_type === 'prepare_house' || r.task_type === 'remove_objects') || null;

  const originalUrl = asset?.original_path ? assetsApi.fileUrl(asset.original_path) : null;
  const preparedUrl = latestPrepared ? assetsApi.fileUrl(latestPrepared.result_path) : null;
  const currentUrl = latestReady ? assetsApi.fileUrl(latestReady.result_path) : (preparedUrl || originalUrl);

  const displayUrl = viewMode === 'original' ? originalUrl : viewMode === 'prepared' ? (preparedUrl || originalUrl) : currentUrl;

  function pickTask(taskId) {
    setSelectedTask(taskId);
    setChangeColorSourceId(null);
    if (taskId !== 'remove_objects' && taskId !== 'custom') setInstruction('');
  }

  function setCategoryColor(key, paint) {
    setColorPlan((prev) => ({ ...prev, [key]: paint }));
  }

  // "Edit colors" on an existing paint revision: jump into visualize_paint
  // pre-filled with that revision's own resolved plan, and explicitly
  // re-source from ITS parent (not its own already-painted result) so
  // Gemini repaints the pre-paint photo rather than painting over paint.
  function editColorsOf(revision) {
    const plan = {};
    for (const entry of revision.surfaceColorPlan || []) {
      plan[entry.surfaceKey] = paintsById.get(entry.paintId) || { id: entry.paintId };
    }
    setColorPlan(plan);
    setInstruction(revision.user_intent || '');
    setChangeColorSourceId(revision.id);
    setSelectedTask('visualize_paint');
  }

  async function generate() {
    if (!selectedTask) return;
    try {
      let revision;
      if (selectedTask === 'prepare_house') {
        revision = await requestIsolation.mutateAsync();
      } else if (selectedTask === 'remove_objects') {
        if (!instruction.trim()) {
          showToast('Describe what to remove first.', { variant: 'danger' });
          return;
        }
        revision = await requestRemoval.mutateAsync(instruction.trim());
      } else {
        // visualize_paint / custom — both go through the recolor pipeline;
        // "custom" without any color assignment still requires at least
        // one catalog color (governing brief §7/§24 — Gemini never invents
        // a color, so a pure "make it look premium" with zero colors
        // selected has nothing catalog-controlled to visualize).
        const surfaceColorPlan = Object.entries(colorPlan)
          .filter(([, paint]) => !!paint)
          .map(([surfaceKey, paint]) => ({ surfaceKey, paintId: paint.id }));
        if (surfaceColorPlan.length === 0) {
          showToast('Assign at least one catalog color first.', { variant: 'danger' });
          return;
        }
        revision = await generateViz.mutateAsync({
          surfaceColorPlan,
          userIntent: instruction.trim() || undefined,
          taskType: changeColorSourceId ? 'change_color' : 'visualize_paint',
          parentRevisionId: changeColorSourceId
            ? (revisions.find((r) => r.id === changeColorSourceId)?.parent_revision_id || undefined)
            : undefined,
        });
      }
      setActiveRevisionId(revision.id);
      setViewMode('current');
    } catch (err) {
      showToast(err.message || 'Could not start generation.', { variant: 'danger' });
    }
  }

  // "Apply to Editable Layers" — the honest bridge (governing brief §11):
  // the generated raster is not itself editable, so acceptance means
  // painting the SAME catalog colors onto real layers via the existing
  // deterministic engine, which is what stays undo/redo-able and exportable.
  //
  // A category (primary-wall, trim, ...) has no mask of its own — masks
  // only exist on real detected_surfaces rows from a house-understanding
  // run. categorySurfaceMap.js bridges the two vocabularies with a
  // best-effort alias match; when no analysis has ever run (fully valid —
  // AI Visualization never requires one), there is honestly nothing to
  // apply yet, and this reports that plainly rather than fabricating a
  // maskless layer.
  async function applyToLayers() {
    const plan = latestReady?.task_type === 'visualize_paint' || latestReady?.task_type === 'change_color'
      ? latestReady.surfaceColorPlan
      : null;
    if (!plan || plan.length === 0) {
      showToast('Nothing to apply — generate a paint visualization first.', { variant: 'danger' });
      return;
    }
    let applied = 0;
    let matchedAnyCategory = false;
    for (const entry of plan) {
      const matches = matchSurfacesForCategory(entry.surfaceKey, analysis?.surfaces);
      if (matches.length > 0) matchedAnyCategory = true;
      for (const surface of matches) {
        try {
          const layer = await applySurface(surface, { id: entry.paintId });
          if (layer) applied += 1;
        } catch {
          // one surface failing shouldn't block the rest — report at the end.
        }
      }
    }
    if (applied > 0) {
      showToast(`Applied ${applied} color${applied > 1 ? 's' : ''} to editable layers.`);
    } else if (matchedAnyCategory) {
      showToast('Could not apply — matching surfaces were found but had no usable mask.', { variant: 'danger' });
    } else {
      showToast('Could not apply automatically — none of these categories have been detected yet. Run "Understand this photo" (AI Details tab), then try again.', { variant: 'danger' });
    }
  }

  return (
    <div className="p-3 flex flex-col gap-3">
      {/* Compare strip: Original / Prepared / Current — always available,
          even before any AI operation has run (Original alone is fine). */}
      <div className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper-raised)] overflow-hidden">
        {displayUrl ? (
          <img src={displayUrl} alt={`${viewMode} house photo`} className="w-full h-40 object-cover" />
        ) : (
          <div className="h-40 flex items-center justify-center text-[11px] text-[var(--graphite)]">No photo yet</div>
        )}
        <div className="flex border-t border-[var(--line)]">
          {[
            { id: 'original', label: 'Original' },
            { id: 'prepared', label: 'Prepared', disabled: !preparedUrl },
            { id: 'current', label: 'Current' },
          ].map((v) => (
            <button
              key={v.id}
              disabled={v.disabled}
              onClick={() => setViewMode(v.id)}
              className={cn(
                'flex-1 py-1.5 text-[11px] font-medium border-r border-[var(--line)] last:border-r-0',
                viewMode === v.id ? 'bg-[var(--signal)]/10 text-[var(--signal)]' : 'text-[var(--graphite)]',
                v.disabled && 'opacity-40'
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* Task selector — always available, no prerequisite. */}
      <div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase text-[var(--graphite)]">What would you like to do?</h3>
        <div className="grid grid-cols-2 gap-1.5">
          {TASKS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => pickTask(id)}
              className={cn(
                'flex flex-col items-start gap-1 rounded-[var(--radius-sm)] border px-2.5 py-2 text-left text-xs font-medium transition-colors',
                selectedTask === id
                  ? 'border-[var(--signal)] bg-[var(--signal)]/10 text-[var(--signal)]'
                  : 'border-[var(--line)] bg-[var(--paper)] text-[var(--ink)] hover:border-[var(--signal)]/50'
              )}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
        {selectedTask && (
          <p className="mt-1.5 text-[11px] leading-snug text-[var(--graphite)]">
            {TASKS.find((t) => t.id === selectedTask)?.description}
          </p>
        )}
      </div>

      {selectedTask === 'prepare_house' && !isolationReady && (
        <p className="text-xs text-[var(--warning)] leading-snug">House preparation is not configured on this deployment.</p>
      )}
      {(selectedTask === 'remove_objects' || selectedTask === 'custom') && !isolationReady && selectedTask === 'remove_objects' && (
        <p className="text-xs text-[var(--warning)] leading-snug">Object removal is not configured on this deployment.</p>
      )}
      {(selectedTask === 'visualize_paint' || selectedTask === 'custom') && !visualizationReady && (
        <p className="text-xs text-[var(--warning)] leading-snug">AI visualization is not configured on this deployment.</p>
      )}

      {(selectedTask === 'remove_objects' || selectedTask === 'custom' || selectedTask === 'visualize_paint') && (
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-[var(--ink)]">
            {selectedTask === 'remove_objects' ? 'What should be removed?' : 'Describe what you want (optional)'}
          </span>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value.slice(0, MAX_INTENT_LENGTH))}
            placeholder={selectedTask === 'remove_objects'
              ? 'e.g. "Remove the people, the ladder and the construction materials."'
              : 'e.g. "Make it feel warm and premium, keep the trim crisp and white."'}
            rows={2}
            maxLength={MAX_INTENT_LENGTH}
            className="w-full resize-none rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper-raised)] px-2 py-1.5 text-[11px] text-[var(--ink)] placeholder:text-[var(--graphite)]/60 focus:outline-none focus:ring-1 focus:ring-[var(--signal)]"
          />
          <span className="self-end text-[10px] text-[var(--graphite)]">{instruction.length}/{MAX_INTENT_LENGTH}</span>
          {selectedTask !== 'remove_objects' && (
            <span className="text-[10px] leading-snug text-[var(--graphite)]">
              Stylistic guidance only — it never changes the specific catalog colors below, and can't
              remove or resize any part of the house.
            </span>
          )}
        </label>
      )}

      {(selectedTask === 'visualize_paint' || selectedTask === 'custom') && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase text-[var(--graphite)]">Catalog colors</h3>
          <ul className="flex flex-col gap-1.5">
            {categories.map((cat) => (
              <li key={cat.key} className="flex items-center justify-between gap-2">
                <span className="text-xs text-[var(--ink)]">{cat.label}</span>
                <InlineColorPicker value={colorPlan[cat.key]} onChange={(paint) => setCategoryColor(cat.key, paint)} />
              </li>
            ))}
          </ul>
          <p className="mt-1.5 flex items-center gap-1 text-[10px] text-[var(--graphite)]">
            <Sparkles size={11} /> Catalog-only — every color is a real product; the AI never invents one.
          </p>
        </div>
      )}

      {selectedTask && (
        <Button onClick={generate} disabled={busy} className="w-full justify-center">
          {busy ? 'Generating…' : changeColorSourceId ? 'Regenerate with updated colors' : 'Generate'}
        </Button>
      )}

      {activeRevision && (
        <GenerationResult
          revision={activeRevision}
          onRegenerate={generate}
          onEditColors={() => editColorsOf(activeRevision)}
          onApplyToLayers={applyToLayers}
        />
      )}

      {revisions.length > 0 && (
        <section className="border-t border-[var(--line)] pt-2.5">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase text-[var(--graphite)]">
            <History size={13} /> Revision history
          </h3>
          <ul className="flex flex-col gap-1">
            {revisions.slice(0, 12).map((r) => (
              <li key={r.id} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5">
                <div className={cn('h-2 w-2 shrink-0 rounded-full',
                  r.status === 'ready' ? 'bg-[var(--success,#2e7d32)]' : r.status === 'failed' ? 'bg-[var(--danger)]' : 'bg-[var(--warning)] animate-pulse')} />
                <span className="flex-1 truncate text-[11px] text-[var(--ink)]">{TASK_LABEL[r.task_type] || r.task_type}</span>
                <span className="text-[10px] text-[var(--graphite)]">{r.status}</span>
                {r.status === 'ready' && (r.task_type === 'visualize_paint' || r.task_type === 'change_color') && (
                  <Button size="sm" variant="ghost" onClick={() => editColorsOf(r)} title="Edit colors from this revision">
                    <RotateCcw size={12} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-auto text-[10px] leading-snug text-[var(--graphite)]">
        Every generated preview is real AI output or nothing is shown — a failed or pending
        generation is always labeled as such, never silently substituted.
      </p>
    </div>
  );
}

const TASK_LABEL = {
  prepare_house: 'Prepared house',
  remove_objects: 'Removed objects',
  visualize_paint: 'Paint visualization',
  change_color: 'Color change',
};

function GenerationResult({ revision, onRegenerate, onEditColors, onApplyToLayers }) {
  const isPaintTask = revision.task_type === 'visualize_paint' || revision.task_type === 'change_color';

  if (revision.status === 'pending') {
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)] px-2 py-2 text-[11px] text-[var(--graphite)]">
        <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[var(--signal)]/40 border-t-[var(--signal)]" />
        {STAGE_LABEL[revision.task_type] || 'Generating…'} this can take up to a minute.
      </div>
    );
  }

  if (revision.status === 'failed') {
    const reason = revision.validationJson?.failureReason || '';
    const isQuota = /quota|429|402|billing|credit|resource_exhausted/i.test(reason);
    return (
      <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--danger)]/30 bg-[var(--danger)]/5 px-2 py-2">
        <p className="text-[11px] font-medium text-[var(--danger)]">Generation failed</p>
        <p className="text-[11px] leading-snug text-[var(--graphite)]">
          {isQuota
            ? 'The AI image-generation provider is currently unavailable for this account (quota/billing limit). Nothing was lost.'
            : (reason ? reason.slice(0, 200) : 'Something went wrong. Nothing was lost.')}
        </p>
        <Button size="sm" variant="secondary" onClick={onRegenerate} className="self-start">Retry</Button>
      </div>
    );
  }

  // ready
  return (
    <div className="flex flex-col gap-1.5">
      <img
        src={assetsApi.fileUrl(revision.result_path)}
        alt="AI-generated result"
        className="w-full rounded-[var(--radius-sm)] border border-[var(--line)] object-cover"
      />
      <div className="flex gap-1.5">
        <Button size="sm" variant="secondary" onClick={onRegenerate} className="flex-1 justify-center">Regenerate</Button>
        {isPaintTask && (
          <>
            <Button size="sm" variant="secondary" onClick={onEditColors} className="flex-1 justify-center">Edit Colors</Button>
            <Button size="sm" onClick={onApplyToLayers} className="flex-1 justify-center">
              <LayersIcon size={13} className="mr-1" /> Apply
            </Button>
          </>
        )}
      </div>
      <p className="text-[10px] text-[var(--graphite)]">
        {isPaintTask
          ? 'AI-generated photorealistic preview. "Apply" paints the same catalog colors with the precision deterministic engine so you can keep refining, undo/redo, and export.'
          : 'AI-generated result — now the base photo for the next operation.'}
      </p>
    </div>
  );
}

const STAGE_LABEL = {
  prepare_house: 'Preparing the house…',
  remove_objects: 'Removing the requested objects…',
  visualize_paint: 'Generating your photorealistic preview…',
  change_color: 'Regenerating with updated colors…',
};
