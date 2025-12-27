import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@lome-chat/ui';
import { User, Settings, CreditCard, LogOut, LogIn, UserPlus, Users } from 'lucide-react';
import { SiGithub } from '@icons-pack/react-simple-icons';

import { useUIStore } from '@/stores/ui';
import { useSession, signOutAndClearCache } from '@/lib/auth';

export function SidebarFooter(): React.JSX.Element {
  const navigate = useNavigate();
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const { data: session } = useSession();

  const isAuthenticated = !!session?.user;

  const handleLogout = async (): Promise<void> => {
    await signOutAndClearCache();
    void navigate({ to: '/login' });
  };

  const displayName = isAuthenticated ? session.user.email : 'Guest User';

  return (
    <div
      data-testid="sidebar-footer"
      className={cn('border-sidebar-border border-t p-2', !sidebarOpen && 'flex justify-center')}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            data-testid="user-menu-trigger"
            className={cn(
              'flex w-full items-center gap-3 rounded-md p-2 transition-colors',
              'hover:bg-sidebar-border/50 focus:outline-none',
              !sidebarOpen && 'justify-center'
            )}
          >
            {/* Avatar */}
            <div className="bg-muted text-muted-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
              <User className="h-4 w-4" data-testid="user-avatar-icon" />
            </div>
            {/* Email + Credits */}
            {sidebarOpen && (
              <div className="flex min-w-0 flex-1 flex-col text-left text-sm">
                <span className="truncate" data-testid="user-email">
                  {displayName}
                </span>
                <span className="text-muted-foreground text-xs" data-testid="user-credits">
                  $0.0000000
                </span>
              </div>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          {isAuthenticated ? (
            <>
              <DropdownMenuItem data-testid="menu-settings">
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem data-testid="menu-add-credits">
                <CreditCard className="mr-2 h-4 w-4" />
                Add Credits
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild data-testid="menu-github">
                <a
                  href="https://github.com/lome-ai/lome-chat"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <SiGithub className="mr-2 h-4 w-4" />
                  GitHub
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  void handleLogout();
                }}
                data-testid="menu-logout"
              >
                <LogOut className="mr-2 h-4 w-4" />
                Log Out
              </DropdownMenuItem>
              {import.meta.env.DEV && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      void navigate({ to: '/dev/personas', search: { type: undefined } });
                    }}
                    data-testid="menu-personas"
                  >
                    <Users className="mr-2 h-4 w-4" />
                    Personas
                  </DropdownMenuItem>
                </>
              )}
            </>
          ) : (
            <>
              <DropdownMenuItem asChild data-testid="menu-github">
                <a
                  href="https://github.com/lome-ai/lome-chat"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <SiGithub className="mr-2 h-4 w-4" />
                  GitHub
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  void navigate({ to: '/login' });
                }}
                data-testid="menu-login"
              >
                <LogIn className="mr-2 h-4 w-4" />
                Log In
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  void navigate({ to: '/signup' });
                }}
                data-testid="menu-signup"
              >
                <UserPlus className="mr-2 h-4 w-4" />
                Sign Up
              </DropdownMenuItem>
              {import.meta.env.DEV && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      void navigate({ to: '/dev/personas', search: { type: undefined } });
                    }}
                    data-testid="menu-personas"
                  >
                    <Users className="mr-2 h-4 w-4" />
                    Personas
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
