import { forwardRef } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] text-sm font-medium ' +
    'transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--signal)] text-white hover:bg-[var(--signal-dark)]',
        secondary:
          'bg-[var(--paper-raised)] text-[var(--ink)] border border-[var(--line)] hover:bg-[var(--paper)]',
        ghost: 'text-[var(--ink)] hover:bg-[var(--paper)]',
        danger: 'bg-[var(--danger)] text-white hover:opacity-90',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-9 px-4',
        icon: 'h-9 w-9 shrink-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
);

const Button = forwardRef(function Button({ className, variant, size, ...props }, ref) {
  return <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});

export { Button, buttonVariants };
