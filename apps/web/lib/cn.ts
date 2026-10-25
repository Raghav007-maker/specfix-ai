import { twMerge } from 'tailwind-merge';

/** Join class names, letting a later Tailwind class override a conflicting earlier one. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return twMerge(parts.filter(Boolean).join(' '));
}
