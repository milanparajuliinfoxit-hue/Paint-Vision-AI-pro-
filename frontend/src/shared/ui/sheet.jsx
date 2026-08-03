import * as RadixDialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../lib/cn';

const Sheet = RadixDialog.Root;
const SheetTrigger = RadixDialog.Trigger;

// A slide-over — used to collapse the always-present left sidebar/right
// inspector into an on-demand panel at tablet widths (requirements doc,
// Section 12) instead of hiding them outright. Panel open/close is exactly
// the "meaningful state transition" Framer Motion is scoped to (Section 11).
function SheetContent({ open, side = 'right', className, children, ...props }) {
  const offscreenX = side === 'left' ? -320 : 320;
  return (
    <AnimatePresence>
      {open && (
        <RadixDialog.Portal forceMount>
          <RadixDialog.Overlay asChild forceMount>
            <motion.div
              className="fixed inset-0 z-40 bg-[var(--ink)]/40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            />
          </RadixDialog.Overlay>
          <RadixDialog.Content asChild forceMount {...props}>
            <motion.div
              className={cn(
                'fixed top-0 z-50 h-full w-[320px] max-w-[90vw] overflow-y-auto',
                side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
                'border-[var(--line)] bg-[var(--paper-raised)] p-4 shadow-[var(--shadow-card)]',
                'focus:outline-none',
                className
              )}
              initial={{ x: offscreenX }}
              animate={{ x: 0 }}
              exit={{ x: offscreenX }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              {children}
            </motion.div>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      )}
    </AnimatePresence>
  );
}

export { Sheet, SheetTrigger, SheetContent };
