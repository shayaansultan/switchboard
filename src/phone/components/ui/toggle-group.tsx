// shadcn's ToggleGroup as a row of pills: one choice of a few, such as a
// filter or a setting with named values.
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/cn';

export function ToggleGroup({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn('flex flex-wrap gap-1.5', className)}
      {...props}
    />
  );
}

export function ToggleGroupItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-sm text-foreground transition-colors data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground',
        className,
      )}
      {...props}
    />
  );
}
