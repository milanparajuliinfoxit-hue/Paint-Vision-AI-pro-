import * as RadixSlider from '@radix-ui/react-slider';
import { cn } from '../lib/cn';

function Slider({ className, ...props }) {
  return (
    <RadixSlider.Root
      className={cn('relative flex h-4 w-full touch-none items-center select-none', className)}
      {...props}
    >
      <RadixSlider.Track className="relative h-1.5 w-full grow rounded-full bg-[var(--line)]">
        <RadixSlider.Range className="absolute h-full rounded-full bg-[var(--signal)]" />
      </RadixSlider.Track>
      <RadixSlider.Thumb
        className="block h-4 w-4 rounded-full border-2 border-[var(--signal)] bg-white focus-visible:outline-none"
        aria-label="value"
      />
    </RadixSlider.Root>
  );
}

export { Slider };
