import * as RadixTabs from '@radix-ui/react-tabs';
import { cn } from '../lib/cn';

const Tabs = RadixTabs.Root;

function TabsList({ className, ...props }) {
  return (
    <RadixTabs.List
      className={cn('flex items-center gap-1 border-b border-[var(--line)] px-2', className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }) {
  return (
    <RadixTabs.Trigger
      className={cn(
        'px-3 py-2 text-xs font-medium text-[var(--graphite)] border-b-2 border-transparent',
        'data-[state=active]:text-[var(--ink)] data-[state=active]:border-[var(--signal)]',
        'hover:text-[var(--ink)] focus-visible:outline-none',
        className
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }) {
  return <RadixTabs.Content className={cn('flex-1 overflow-y-auto', className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
