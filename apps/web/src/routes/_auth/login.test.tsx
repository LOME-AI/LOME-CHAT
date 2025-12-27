import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { signIn } from '@/lib/auth';
import { toast } from '@lome-chat/ui';

// Mock TanStack Router
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => vi.fn()),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: vi.fn(() => vi.fn()),
}));

// Mock auth client
vi.mock('@/lib/auth', () => ({
  signIn: {
    email: vi.fn(),
  },
}));

// Mock UI components
vi.mock('@lome-chat/ui', () => ({
  toast: {
    error: vi.fn(),
  },
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Mock AuthInput
vi.mock('@/components/auth/AuthInput', () => ({
  AuthInput: ({
    label,
    id,
    error,
    success,
    ...props
  }: {
    label: string;
    id?: string;
    error?: string;
    success?: string;
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input id={id} {...props} />
      {error && <span role="alert">{error}</span>}
      {success && id && <span data-testid={`${id}-success`}>{success}</span>}
    </div>
  ),
}));

// Mock AuthPasswordInput
vi.mock('@/components/auth/AuthPasswordInput', () => ({
  AuthPasswordInput: ({
    label,
    id,
    error,
    success,
    ...props
  }: {
    label: string;
    id?: string;
    error?: string;
    success?: string;
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input type="password" id={id} {...props} />
      {error && <span role="alert">{error}</span>}
      {success && id && <span data-testid={`${id}-success`}>{success}</span>}
    </div>
  ),
}));

// Mock AuthButton
vi.mock('@/components/auth/AuthButton', () => ({
  AuthButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders login form with email and password fields', async () => {
    const { LoginPage } = await import('./login');

    render(<LoginPage />);

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
  });

  it('renders signup link', async () => {
    const { LoginPage } = await import('./login');

    render(<LoginPage />);

    expect(screen.getByRole('link', { name: /sign up/i })).toHaveAttribute('href', '/signup');
  });

  it('validates email format on submit', async () => {
    const user = userEvent.setup();
    const { LoginPage } = await import('./login');

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'invalid-email');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).not.toHaveBeenCalled();
  });

  it('validates required fields on submit', async () => {
    const user = userEvent.setup();
    const { LoginPage } = await import('./login');

    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).not.toHaveBeenCalled();
  });

  it('calls signIn.email with valid credentials', async () => {
    vi.mocked(signIn.email).mockResolvedValue({ data: {}, error: null });
    const user = userEvent.setup();
    const { LoginPage } = await import('./login');

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).toHaveBeenCalledWith({
      email: 'test@example.com',
      password: 'password123',
    });
  });

  it('shows error toast on authentication failure', async () => {
    vi.mocked(signIn.email).mockResolvedValue({
      data: null,
      error: { message: 'Invalid credentials' },
    });
    const user = userEvent.setup();
    const { LoginPage } = await import('./login');

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(toast.error).toHaveBeenCalledWith('Invalid credentials');
  });

  it('shows fallback error message when error has no message', async () => {
    vi.mocked(signIn.email).mockResolvedValue({
      data: null,
      error: {},
    });
    const user = userEvent.setup();
    const { LoginPage } = await import('./login');

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(toast.error).toHaveBeenCalledWith('Authentication failed');
  });

  it('shows success message when email is valid as user types', async () => {
    const user = userEvent.setup();
    const { LoginPage } = await import('./login');

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');

    expect(screen.getByTestId('email-success')).toHaveTextContent('Valid email');
  });

  it('shows error message when email is invalid as user types', async () => {
    const user = userEvent.setup();
    const { LoginPage } = await import('./login');

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), 'invalid');

    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a valid email');
  });
});
