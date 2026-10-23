import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Server-safe class joiner (components/ui.tsx is a client module, so server components use this). */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
