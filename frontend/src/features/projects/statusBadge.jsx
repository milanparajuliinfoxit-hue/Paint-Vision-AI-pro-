const STATUS_LABEL = {
  draft: 'Draft',
  in_review: 'In review',
  client_approved: 'Client approved',
  archived: 'Archived',
};

const STATUS_COLOR = {
  draft: 'bg-[var(--line)] text-[var(--graphite-dark)]',
  in_review: 'bg-[var(--warning)]/15 text-[var(--warning)]',
  client_approved: 'bg-[var(--success)]/15 text-[var(--success)]',
  archived: 'bg-[var(--graphite)]/15 text-[var(--graphite-dark)]',
};

export default function StatusBadge({ status }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[status] || STATUS_COLOR.draft}`}
    >
      {STATUS_LABEL[status] || status}
    </span>
  );
}
