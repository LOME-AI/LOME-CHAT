import * as React from 'react';
import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { toast } from '@lome-chat/ui';
import { Mail, User } from 'lucide-react';
import { signUp } from '@/lib/auth';
import { AuthInput } from '@/components/auth/AuthInput';
import { AuthButton } from '@/components/auth/AuthButton';
import { AuthPasswordInput } from '@/components/auth/AuthPasswordInput';
import { PasswordStrength } from '@/components/auth/PasswordStrength';
import {
  validateName,
  validateEmail,
  validatePassword,
  validateConfirmPassword,
} from '@/lib/validation';

export const Route = createFileRoute('/_auth/signup')({
  component: SignupPage,
});

export function SignupPage(): React.JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [touched, setTouched] = useState({
    name: false,
    email: false,
    password: false,
    confirmPassword: false,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  // Real-time validation
  const nameValidation = touched.name ? validateName(name) : { isValid: false };
  const emailValidation = touched.email ? validateEmail(email) : { isValid: false };
  const passwordValidation = touched.password ? validatePassword(password) : { isValid: false };
  const confirmPasswordValidation = touched.confirmPassword
    ? validateConfirmPassword(password, confirmPassword)
    : { isValid: false };

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();

    // Mark all as touched on submit
    setTouched({ name: true, email: true, password: true, confirmPassword: true });

    // Validate before submit
    const nameResult = validateName(name);
    const emailResult = validateEmail(email);
    const passwordResult = validatePassword(password);
    const confirmPasswordResult = validateConfirmPassword(password, confirmPassword);

    if (
      !nameResult.isValid ||
      !emailResult.isValid ||
      !passwordResult.isValid ||
      !confirmPasswordResult.isValid
    ) {
      return;
    }

    setIsLoading(true);
    try {
      const response = await signUp.email({ name, email, password });
      if (response.error) {
        toast.error(response.error.message ?? 'Signup failed');
        return;
      }
      setIsSuccess(true);
    } finally {
      setIsLoading(false);
    }
  }

  if (isSuccess) {
    return (
      <div className="text-center">
        <h1 className="text-foreground mb-2 text-3xl font-bold">Check your email</h1>
        <p className="text-muted-foreground">
          We&apos;ve sent a verification link to {email}. Click the link to verify your account.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Header with tagline */}
      <div className="mb-8 text-center">
        <h1 className="text-foreground mb-2 text-3xl font-bold">Create your account</h1>
        <p className="text-primary text-lg font-medium">One interface for all AI</p>
      </div>

      <form
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
        className="space-y-4"
      >
        <AuthInput
          id="name"
          label="Name"
          type="text"
          icon={<User className="h-5 w-5" />}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!touched.name) setTouched((t) => ({ ...t, name: true }));
          }}
          aria-invalid={!!nameValidation.error}
          error={nameValidation.error}
          success={nameValidation.success}
        />

        <AuthInput
          id="email"
          label="Email"
          type="email"
          icon={<Mail className="h-5 w-5" />}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (!touched.email) setTouched((t) => ({ ...t, email: true }));
          }}
          aria-invalid={!!emailValidation.error}
          error={emailValidation.error}
          success={emailValidation.success}
        />

        <div>
          <AuthPasswordInput
            id="password"
            label="Password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (!touched.password) setTouched((t) => ({ ...t, password: true }));
            }}
            aria-invalid={!!passwordValidation.error}
            error={passwordValidation.error}
            success={passwordValidation.success}
          />
          <PasswordStrength password={password} />
        </div>

        <AuthPasswordInput
          id="confirmPassword"
          label="Confirm password"
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            if (!touched.confirmPassword) setTouched((t) => ({ ...t, confirmPassword: true }));
          }}
          aria-invalid={!!confirmPasswordValidation.error}
          error={confirmPasswordValidation.error}
          success={confirmPasswordValidation.success}
        />

        <AuthButton type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? 'Creating account...' : 'Create account'}
        </AuthButton>

        <p className="text-muted-foreground text-center text-sm">
          Already have an account?{' '}
          <Link to="/login" className="text-primary hover:underline">
            Log in
          </Link>
        </p>
      </form>

      {/* Feature bullets */}
      <div className="border-border mt-8 border-t pt-6">
        <ul className="text-muted-foreground space-y-3 text-sm">
          <li className="flex items-center gap-3">
            <span className="text-primary text-lg">✓</span>
            Access GPT, Claude, Gemini & more
          </li>
          <li className="flex items-center gap-3">
            <span className="text-primary text-lg">✓</span>
            Switch models mid-conversation
          </li>
          <li className="flex items-center gap-3">
            <span className="text-primary text-lg">✓</span>
            Your data stays yours
          </li>
        </ul>
      </div>
    </div>
  );
}
