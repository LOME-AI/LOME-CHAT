import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Accessibility,
  Check,
  Database,
  ExternalLink as ExternalLinkIcon,
  Image,
  Mail,
  Shield,
  Smartphone,
  User,
  Settings,
  CreditCard,
  BarChart3,
  LogOut,
  LogIn,
  UserPlus,
  Users,
  MessageSquarePlus,
} from 'lucide-react';
import { SiGithub } from '@icons-pack/react-simple-icons';
import { DropdownMenuItem, DropdownMenuSeparator } from '@hushbox/ui';
import { FEATURE_FLAGS, displayUsername, ROUTES, TEST_IDS } from '@hushbox/shared';
import { ExternalPageLink } from '@/components/shared/external-page-link';

import { useUIStore } from '@/stores/ui';
import { useTouchOverrideStore } from '@/stores/touch-override';
import { useSession, signOutAndClearCache } from '@/lib/auth';
import { useStableBalance } from '@/hooks/billing/use-stable-balance';
import { buildDrizzleStudioUrl } from '@/lib/routes';
import { formatBalance } from '@/lib/format';
import { DevOnly } from '@/components/shared/dev-only';
import { SidebarFooterBase } from '@/components/shared/sidebar-footer-base';
import { FeedbackModal } from '@/components/feedback/feedback-modal';
import { env } from '@/lib/env';

// Reads a dev-tool origin the env registry defines for every mode DevOnly
// renders (Development + local E2E). A missing value behind that mode gate is a
// config defect, so this fails fast rather than emitting an `undefined/…` href.
function devToolUrl(key: 'VITE_DRIZZLE_STUDIO_URL' | 'VITE_ADMIN_URL'): string {
  const url = import.meta.env[key] as string | undefined;
  if (url === undefined || url === '') {
    throw new Error(`${key} must be defined when the dev server runs`);
  }
  return url;
}

function GitHubMenuItem(): React.JSX.Element {
  return (
    <DropdownMenuItem asChild data-testid={TEST_IDS.menuGithub}>
      <a href="https://github.com/lome-ai/hushbox" target="_blank" rel="noopener noreferrer">
        <SiGithub className="mr-2 h-4 w-4" />
        GitHub
      </a>
    </DropdownMenuItem>
  );
}

function MarketingMenuItem(): React.JSX.Element {
  return (
    <DropdownMenuItem asChild data-testid={TEST_IDS.menuMarketing}>
      <ExternalPageLink path={ROUTES.MARKETING}>
        <ExternalLinkIcon className="mr-2 h-4 w-4" />
        About HushBox
      </ExternalPageLink>
    </DropdownMenuItem>
  );
}

function DevMenuItems({
  navigate,
  closeMobileSidebar,
}: Readonly<{
  navigate: ReturnType<typeof useNavigate>;
  closeMobileSidebar: () => void;
}>): React.JSX.Element {
  const touchOverride = useTouchOverrideStore((state) => state.override);
  const toggleTouch = useTouchOverrideStore((state) => state.toggle);

  return (
    <DevOnly>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.DEV_PERSONAS, search: { type: undefined } });
        }}
        data-testid={TEST_IDS.menuPersonas}
      >
        <Users className="mr-2 h-4 w-4" />
        Personas
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.DEV_EMAILS });
        }}
        data-testid={TEST_IDS.menuEmails}
      >
        <Mail className="mr-2 h-4 w-4" />
        Emails
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.DEV_ASSETS });
        }}
        data-testid={TEST_IDS.menuAssets}
      >
        <Image className="mr-2 h-4 w-4" />
        Assets
      </DropdownMenuItem>
      {/* Branch on mode, not on the vars' presence: the `&&` short-circuits so
          the URL reads never run outside local dev, and behind that mode gate
          the registry guarantees the values (devToolUrl fails fast otherwise). */}
      {env.isLocalDev && (
        <DropdownMenuItem asChild data-testid={TEST_IDS.menuDbStudio}>
          <a
            href={buildDrizzleStudioUrl(devToolUrl('VITE_DRIZZLE_STUDIO_URL'))}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Database className="mr-2 h-4 w-4" />
            Database Studio
          </a>
        </DropdownMenuItem>
      )}
      {env.isLocalDev && (
        <DropdownMenuItem asChild data-testid={TEST_IDS.menuAdmin}>
          <a href={devToolUrl('VITE_ADMIN_URL')} target="_blank" rel="noopener noreferrer">
            <Shield className="mr-2 h-4 w-4" />
            Admin
          </a>
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onClick={(e) => {
          e.preventDefault();
          toggleTouch();
        }}
        data-testid={TEST_IDS.menuTouchMode}
      >
        <Smartphone className="mr-2 h-4 w-4" />
        Touch Mode
        {touchOverride === true && <Check className="ml-auto h-4 w-4" />}
      </DropdownMenuItem>
    </DevOnly>
  );
}

interface MenuItemsProps {
  navigate: ReturnType<typeof useNavigate>;
  closeMobileSidebar: () => void;
}

function AccessibilityMenuItem({
  navigate,
  closeMobileSidebar,
}: Readonly<MenuItemsProps>): React.JSX.Element {
  return (
    <DropdownMenuItem
      onClick={() => {
        closeMobileSidebar();
        void navigate({ to: ROUTES.ACCESSIBILITY });
      }}
      data-testid={TEST_IDS.menuAccessibility}
    >
      <Accessibility className="mr-2 h-4 w-4" />
      Accessibility
    </DropdownMenuItem>
  );
}

function AuthenticatedMenuItems({
  navigate,
  closeMobileSidebar,
  onFeedback,
}: Readonly<MenuItemsProps & { onFeedback: () => void }>): React.JSX.Element {
  const handleLogout = async (): Promise<void> => {
    await signOutAndClearCache();
    void navigate({ to: ROUTES.LOGIN });
  };

  return (
    <>
      {FEATURE_FLAGS.SETTINGS_ENABLED && (
        <DropdownMenuItem
          onClick={() => {
            closeMobileSidebar();
            void navigate({ to: ROUTES.SETTINGS });
          }}
          data-testid={TEST_IDS.menuSettings}
        >
          <Settings className="mr-2 h-4 w-4" />
          Settings
        </DropdownMenuItem>
      )}
      <AccessibilityMenuItem navigate={navigate} closeMobileSidebar={closeMobileSidebar} />
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.USAGE });
        }}
        data-testid={TEST_IDS.menuUsage}
      >
        <BarChart3 className="mr-2 h-4 w-4" />
        Usage
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.BILLING });
        }}
        data-testid={TEST_IDS.menuAddCredits}
      >
        <CreditCard className="mr-2 h-4 w-4" />
        Add Credits
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onFeedback} data-testid={TEST_IDS.menuFeedback}>
        <MessageSquarePlus className="mr-2 h-4 w-4" />
        Send feedback
      </DropdownMenuItem>
      <GitHubMenuItem />
      <MarketingMenuItem />
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void handleLogout();
        }}
        data-testid={TEST_IDS.menuLogout}
      >
        <LogOut className="mr-2 h-4 w-4" />
        Log Out
      </DropdownMenuItem>
      <DevMenuItems navigate={navigate} closeMobileSidebar={closeMobileSidebar} />
    </>
  );
}

function TrialMenuItems({
  navigate,
  closeMobileSidebar,
}: Readonly<MenuItemsProps>): React.JSX.Element {
  return (
    <>
      <AccessibilityMenuItem navigate={navigate} closeMobileSidebar={closeMobileSidebar} />
      <DropdownMenuSeparator />
      <GitHubMenuItem />
      <MarketingMenuItem />
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.LOGIN });
        }}
        data-testid={TEST_IDS.menuLogin}
      >
        <LogIn className="mr-2 h-4 w-4" />
        Log In
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => {
          closeMobileSidebar();
          void navigate({ to: ROUTES.SIGNUP });
        }}
        data-testid={TEST_IDS.menuSignup}
      >
        <UserPlus className="mr-2 h-4 w-4" />
        Sign Up
      </DropdownMenuItem>
      <DevMenuItems navigate={navigate} closeMobileSidebar={closeMobileSidebar} />
    </>
  );
}

export function SidebarFooter(): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const setMobileSidebarOpen = useUIStore((state) => state.setMobileSidebarOpen);
  const { data: session } = useSession();
  const { displayBalance, isStable } = useStableBalance();
  const navigate = useNavigate();
  const [feedbackOpen, setFeedbackOpen] = React.useState(false);

  const closeMobileSidebar = React.useCallback(() => {
    setMobileSidebarOpen(false);
  }, [setMobileSidebarOpen]);

  const openFeedback = React.useCallback(() => {
    closeMobileSidebar();
    setFeedbackOpen(true);
  }, [closeMobileSidebar]);

  const isAuthenticated = !!session?.user;
  const displayName = isAuthenticated ? displayUsername(session.user.username) : 'Trial User';
  let sublabel: string | undefined;
  if (isAuthenticated) {
    sublabel = isStable ? formatBalance(displayBalance) : '$...';
  }

  return (
    <>
      <SidebarFooterBase
        icon={<User className="h-4 w-4" data-testid={TEST_IDS.userAvatarIcon} />}
        label={displayName}
        sublabel={sublabel}
        collapsed={!sidebarOpen}
        testId={TEST_IDS.sidebar}
        dropdownContent={
          isAuthenticated ? (
            <AuthenticatedMenuItems
              navigate={navigate}
              closeMobileSidebar={closeMobileSidebar}
              onFeedback={openFeedback}
            />
          ) : (
            <TrialMenuItems navigate={navigate} closeMobileSidebar={closeMobileSidebar} />
          )
        }
      />
      <FeedbackModal open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </>
  );
}
