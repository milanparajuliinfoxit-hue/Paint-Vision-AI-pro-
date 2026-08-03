import { createContext, useCallback, useContext, useState } from 'react';
import * as RadixToast from '@radix-ui/react-toast';
import { cn } from '../lib/cn';

const ToastContext = createContext(null);

let idCounter = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const showToast = useCallback((message, { variant = 'default', duration = 5000 } = {}) => {
    const id = ++idCounter;
    setToasts((prev) => [...prev, { id, message, variant, duration }]);
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={showToast}>
      <RadixToast.Provider swipeDirection="right">
        {children}
        {toasts.map((t) => (
          <RadixToast.Root
            key={t.id}
            duration={t.duration}
            onOpenChange={(open) => !open && dismiss(t.id)}
            className={cn(
              'rounded-[var(--radius-md)] border px-4 py-3 shadow-[var(--shadow-card)] text-sm',
              t.variant === 'danger'
                ? 'bg-[var(--danger)] text-white border-transparent'
                : 'bg-[var(--paper-raised)] text-[var(--ink)] border-[var(--line)]'
            )}
          >
            <RadixToast.Description>{t.message}</RadixToast.Description>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className="fixed bottom-4 right-4 z-[100] flex w-80 max-w-[90vw] flex-col gap-2 outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

// Radix's toast Description/Viewport already carries the right aria roles
// (role="status" for the region), so save-status/export-completion
// announcements (requirements doc, Section 12) get an ARIA live region for
// free by routing through this hook instead of a bespoke banner.
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
