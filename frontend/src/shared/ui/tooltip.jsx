import * as RadixTooltip from '@radix-ui/react-tooltip';
import { cn } from '../lib/cn';

const TooltipProvider = RadixTooltip.Provider;
const Tooltip = RadixTooltip.Root;
const TooltipTrigger = RadixTooltip.Trigger;

function TooltipContent({ className, sideOffset = 6, ...props }) {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-[var(--radius-sm)] bg-[var(--ink)] px-2 py-1 text-xs text-white shadow-[var(--shadow-card)]',
          className
        )}
        {...props}
      />
    </RadixTooltip.Portal>
  );
}

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent };
