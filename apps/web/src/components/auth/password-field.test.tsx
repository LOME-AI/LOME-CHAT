import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PasswordField, ConfirmPasswordField } from './password-field';

describe('PasswordField', () => {
  const baseProps = {
    id: 'password',
    label: 'Password',
    password: '',
    setPassword: vi.fn(),
    touched: false,
    markTouched: vi.fn(),
  };

  it('forwards the autoComplete prop to the input', () => {
    render(<PasswordField {...baseProps} autoComplete="current-password" />);

    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('does not validate while untouched', () => {
    render(<PasswordField {...baseProps} touched={false} password="short" />);

    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'false');
  });

  it('marks the field invalid when touched with an invalid password', () => {
    render(<PasswordField {...baseProps} touched password="short" />);

    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
  });

  it('reports success when touched with a valid password', () => {
    render(<PasswordField {...baseProps} touched password="ValidPass123!" />);

    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByText('Password meets requirements')).toBeInTheDocument();
  });

  it('calls setPassword and marks touched on first change', () => {
    const setPassword = vi.fn();
    const markTouched = vi.fn();
    render(
      <PasswordField
        {...baseProps}
        touched={false}
        setPassword={setPassword}
        markTouched={markTouched}
      />
    );

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'abc' } });

    expect(setPassword).toHaveBeenCalledWith('abc');
    expect(markTouched).toHaveBeenCalledTimes(1);
  });

  it('does not re-mark touched once already touched', () => {
    const markTouched = vi.fn();
    render(<PasswordField {...baseProps} touched markTouched={markTouched} />);

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'abcd' } });

    expect(markTouched).not.toHaveBeenCalled();
  });
});

describe('ConfirmPasswordField', () => {
  const baseProps = {
    id: 'confirm-password',
    label: 'Confirm Password',
    newPassword: '',
    confirmPassword: '',
    setConfirmPassword: vi.fn(),
    touched: false,
    markTouched: vi.fn(),
  };

  it('marks the input with new-password autocomplete', () => {
    render(<ConfirmPasswordField {...baseProps} />);

    expect(screen.getByLabelText('Confirm Password')).toHaveAttribute(
      'autocomplete',
      'new-password'
    );
  });

  it('flags a mismatch when touched', () => {
    render(
      <ConfirmPasswordField
        {...baseProps}
        touched
        newPassword="ValidPass123!"
        confirmPassword="different"
      />
    );

    expect(screen.getByLabelText('Confirm Password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
  });

  it('reports success when the passwords match', () => {
    render(
      <ConfirmPasswordField
        {...baseProps}
        touched
        newPassword="ValidPass123!"
        confirmPassword="ValidPass123!"
      />
    );

    expect(screen.getByText('Passwords match')).toBeInTheDocument();
  });

  it('calls setConfirmPassword and marks touched on first change', () => {
    const setConfirmPassword = vi.fn();
    const markTouched = vi.fn();
    render(
      <ConfirmPasswordField
        {...baseProps}
        touched={false}
        setConfirmPassword={setConfirmPassword}
        markTouched={markTouched}
      />
    );

    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'xyz' } });

    expect(setConfirmPassword).toHaveBeenCalledWith('xyz');
    expect(markTouched).toHaveBeenCalledTimes(1);
  });

  it('does not re-mark touched once already touched', () => {
    const markTouched = vi.fn();
    render(<ConfirmPasswordField {...baseProps} touched markTouched={markTouched} />);

    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'xyzz' } });

    expect(markTouched).not.toHaveBeenCalled();
  });
});
