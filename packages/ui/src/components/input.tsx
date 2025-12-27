import * as React from 'react';
import { useState } from 'react';

import { cn } from '../lib/utils';

interface InputProps extends React.ComponentProps<'input'> {
  label?: string;
  icon?: React.ReactNode;
  suffix?: React.ReactNode;
}

function Input({
  className,
  type,
  label,
  icon,
  suffix,
  id,
  value,
  onFocus,
  onBlur,
  ...props
}: InputProps): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  const hasValue = value !== undefined && String(value).length > 0;
  const isActive = focused || hasValue;
  const hasLabel = !!label;
  const hasIcon = !!icon;
  const hasSuffix = !!suffix;

  function handleFocus(e: React.FocusEvent<HTMLInputElement>): void {
    setFocused(true);
    onFocus?.(e);
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>): void {
    setFocused(false);
    onBlur?.(e);
  }

  // Simple input without label/icon/suffix
  if (!hasLabel && !hasIcon && !hasSuffix) {
    return (
      <input
        type={type}
        id={id}
        value={value}
        data-slot="input"
        className={cn(
          'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
          'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
          className
        )}
        {...props}
      />
    );
  }

  // Enhanced input with label, icon, and/or suffix
  return (
    <div className="relative">
      {/* Floating label */}
      {hasLabel && (
        <label
          htmlFor={id}
          className={cn(
            'pointer-events-none absolute transition-all duration-200',
            hasIcon ? 'left-10' : 'left-3',
            isActive
              ? 'text-primary top-2 text-xs'
              : 'text-muted-foreground top-1/2 -translate-y-1/2 text-sm'
          )}
        >
          {label}
        </label>
      )}

      {/* Icon */}
      {hasIcon && (
        <div
          data-testid="input-icon"
          className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2"
        >
          {icon}
        </div>
      )}

      {/* Input */}
      <input
        type={type}
        id={id}
        value={value}
        onFocus={handleFocus}
        onBlur={handleBlur}
        data-slot="input"
        className={cn(
          'h-auto w-full rounded-lg border-2 bg-transparent text-sm shadow-none',
          'border-border-strong focus:border-primary focus-visible:ring-0 focus-visible:outline-none',
          'transition-colors',
          hasIcon ? 'pl-10' : 'pl-3',
          hasLabel ? 'pt-6 pb-2' : 'py-3',
          hasSuffix ? 'pr-10' : 'pr-3',
          className
        )}
        {...props}
      />

      {/* Suffix */}
      {hasSuffix && (
        <div data-testid="input-suffix" className="absolute top-1/2 right-3 -translate-y-1/2">
          {suffix}
        </div>
      )}
    </div>
  );
}

export { Input };
export type { InputProps };
