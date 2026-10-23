'use client';

/**
 * Minimal shadcn/ui-style primitives (same API shape: cva variants + cn), styled with the
 * Datascribe brand tokens. Kept in one file until a second app needs them (then → packages/ui).
 */
import { cva, type VariantProps } from 'class-variance-authority';
import { clsx, type ClassValue } from 'clsx';
import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-brand-600 text-white hover:bg-brand-700',
        secondary: 'border border-line bg-white text-ink hover:bg-surface',
        ghost: 'text-body hover:bg-surface',
        danger: 'bg-red-700 text-white hover:bg-red-800',
      },
      size: { sm: 'h-8 px-3', md: 'h-10 px-4' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>
>(({ className, variant, size, type = 'button', ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(buttonVariants({ variant, size }), className)}
    {...props}
  />
));
Button.displayName = 'Button';

const field =
  'block w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-100 aria-[invalid=true]:border-red-600';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(field, 'h-10', className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(field, className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select ref={ref} className={cn(field, 'h-10', className)} {...props} />
  ),
);
Select.displayName = 'Select';

export function Field({
  label,
  htmlFor,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-line bg-white p-5', className)}>{children}</div>
  );
}

const badgeVariants = cva('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'bg-gray-100 text-gray-800',
      brand: 'bg-brand-100 text-brand-800',
      green: 'bg-green-100 text-green-800',
      red: 'bg-red-100 text-red-800',
      amber: 'bg-amber-100 text-amber-900',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({
  tone,
  children,
}: VariantProps<typeof badgeVariants> & { children: ReactNode }) {
  return <span className={badgeVariants({ tone })}>{children}</span>;
}

/** Native <dialog>: focus trapping, Esc to close and the backdrop come from the browser. */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="dialog-title"
      className="m-auto w-full max-w-lg rounded-lg border border-line p-0 backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 id="dialog-title" className="text-base font-semibold text-ink">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-muted hover:bg-surface"
        >
          ✕
        </button>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
      {error instanceof Error ? error.message : 'Something went wrong'}
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted">{children}</p>;
}
