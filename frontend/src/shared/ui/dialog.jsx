import * as RadixDialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../lib/cn';

const Dialog = RadixDialog.Root;
const DialogTrigger = RadixDialog.Trigger;

// Modal enter/exit is exactly the "meaningful state transition" Framer
// Motion is scoped to (requirements doc, Section 11) — everything else in
// this app stays un-animated.
function DialogContent({ open, className, children, ...props }) {
  return (
    <AnimatePresence>
      {open && (
        <RadixDialog.Portal forceMount>
          <RadixDialog.Overlay asChild forceMount>
            <motion.div
              className="fixed inset-0 z-50 bg-[var(--ink)]/40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            />
          </RadixDialog.Overlay>
          <RadixDialog.Content asChild forceMount {...props}>
            <motion.div
              className={cn(
                'fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2',
                'rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper-raised)] p-6 shadow-[var(--shadow-card)]',
                'focus:outline-none',
                className
              )}
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.15 }}
            >
              {children}
            </motion.div>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      )}
    </AnimatePresence>
  );
}

function DialogTitle({ className, ...props }) {
  return <RadixDialog.Title className={cn('text-base font-semibold mb-3', className)} {...props} />;
}

function DialogDescription({ className, ...props }) {
  return <RadixDialog.Description className={cn('text-sm text-[var(--graphite)] mb-4', className)} {...props} />;
}

export { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription };
