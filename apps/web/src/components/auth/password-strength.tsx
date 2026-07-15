import * as React from 'react';
import { cn } from '@hushbox/ui';
import { MIN_PASSWORD_LENGTH, TEST_IDS } from '@hushbox/shared';

interface PasswordStrengthProps {
  password: string;
}

function calculateStrength(password: string): number {
  if (!password) return 0;
  if (password.length < MIN_PASSWORD_LENGTH) return 1;

  const criteriaCount = [
    /[a-z]/.test(password) && /[A-Z]/.test(password),
    /\d/.test(password),
    /[!@#$%^&*(),.?":{}|<>]/.test(password),
  ].filter(Boolean).length;

  if (password.length >= 10 && criteriaCount >= 2) return 3;
  if (criteriaCount >= 1) return 2;
  return 1;
}

function getStrengthLabel(strength: number): string {
  switch (strength) {
    case 1: {
      return 'Weak';
    }
    case 2: {
      return 'Medium';
    }
    case 3: {
      return 'Strong';
    }
    default: {
      return '';
    }
  }
}

function getStrengthColor(strength: number): string {
  switch (strength) {
    case 1: {
      return 'bg-error';
    }
    case 2: {
      return 'bg-warning';
    }
    case 3: {
      return 'bg-success';
    }
    default: {
      return 'bg-border';
    }
  }
}

export function PasswordStrength({ password }: Readonly<PasswordStrengthProps>): React.JSX.Element {
  const strength = calculateStrength(password);
  const hasPassword = password.length > 0;

  return (
    <div
      data-testid={TEST_IDS.strengthIndicator}
      className={cn(
        'mt-1 overflow-hidden transition-[height] duration-150 ease-out',
        hasPassword ? 'h-6' : 'h-0'
      )}
    >
      <div
        className={cn(
          'space-y-1 transition-opacity duration-200',
          hasPassword ? 'opacity-100 delay-150' : 'opacity-0'
        )}
      >
        <div className="flex gap-1">
          {[1, 2, 3].map((segment) => (
            <div
              key={segment}
              data-testid={TEST_IDS.strengthSegment}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                segment <= strength ? getStrengthColor(strength) : 'bg-border'
              )}
            />
          ))}
        </div>
        <p className="text-muted-foreground text-xs">{getStrengthLabel(strength)}</p>
      </div>
    </div>
  );
}
