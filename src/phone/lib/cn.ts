// Class names the shadcn way: conditional parts joined, conflicting Tailwind
// utilities resolved in favour of the last.
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
