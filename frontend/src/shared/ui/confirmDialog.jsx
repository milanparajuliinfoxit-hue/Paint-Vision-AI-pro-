import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './dialog';
import { Button } from './button';

// Replaces window.confirm() — same call-site shape (open/onOpenChange +
// onConfirm), but modal styling, keyboard support (Esc to cancel, Enter/
// Space on the focused action) and focus management all come from the
// existing Radix Dialog primitive instead of the browser chrome.
export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel', destructive = false, onConfirm,
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent open={open} className="max-w-sm">
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
        <div className="flex justify-end gap-2 mt-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
          <Button
            autoFocus
            variant={destructive ? 'danger' : 'primary'}
            onClick={() => { onConfirm(); onOpenChange(false); }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Replaces window.prompt(). Manages its own text field; onConfirm only
// fires with a non-empty trimmed value, mirroring prompt()'s common usage
// (callers today already guard on a truthy/non-null result).
export function InputDialog({
  open, onOpenChange, title, label, defaultValue = '', placeholder, confirmLabel = 'Save', cancelLabel = 'Cancel', onConfirm,
}) {
  const [value, setValue] = useState(defaultValue);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (next) setValue(defaultValue); onOpenChange(next); }}>
      <DialogContent open={open} className="max-w-sm">
        <DialogTitle>{title}</DialogTitle>
        <label className="flex flex-col gap-1.5 text-xs">
          {label && <span className="text-[var(--graphite)]">{label}</span>}
          <input
            autoFocus
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
            className="rounded-[var(--radius-sm)] border border-[var(--line)] px-2 py-1.5 text-sm"
          />
        </label>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
          <Button variant="primary" disabled={!value.trim()} onClick={submit}>{confirmLabel}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
