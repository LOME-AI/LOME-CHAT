import * as React from 'react';
import { useState, useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Shield, Key, FileText, Scale, ChevronRight, MessageSquare } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Button } from '@hushbox/ui';
import { PRIVACY_POLICY_META } from '@hushbox/shared/legal';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { requireAuth, useAuthStore } from '@/lib/auth';
import { useChangePassword } from '@/hooks/auth/auth-mutations';
import { openExternalPage } from '@/capacitor';
import { PageHeader } from '@/components/shared/page-header';
import { PageBody } from '@/components/shared/page-body';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { ChangePasswordModal } from '@/components/auth/change-password-modal';
import { TwoFactorSetup } from '@/components/auth/two-factor-setup';
import { DisableTwoFactorModal } from '@/components/auth/disable-two-factor-modal';
import { RecoveryPhraseModal } from '@/components/auth/recovery-phrase-modal';
import { RegenerateConfirmModal } from '@/components/auth/regenerate-confirm-modal';
import { CustomInstructionsModal } from '@/components/settings/custom-instructions-modal';
import { MailingListCard } from '@/components/settings/mailing-list-card';
import { NotificationsCard } from '@/components/settings/notifications-card';
import { DeleteAccountModal } from '@/components/settings/delete-account-modal';

export const Route = createFileRoute('/_app/settings')({
  beforeLoad: async () => {
    await requireAuth();
  },
  component: SettingsPage,
});

interface SettingItemProps {
  icon: React.ElementType;
  title: string;
  description: string;
  onClick: () => void;
  statusBadge?: React.ReactNode;
}

function SettingItem({
  icon: Icon,
  title,
  description,
  onClick,
  statusBadge,
}: Readonly<SettingItemProps>): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      className="h-auto w-full p-4 text-left whitespace-normal"
      onClick={onClick}
    >
      <div className="w-full">
        <div className="flex items-center gap-2">
          <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate font-medium">{title}</span>
          {statusBadge}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <p className="text-muted-foreground min-w-0 flex-1 text-sm">{description}</p>
          <ChevronRight className="text-muted-foreground h-5 w-5 shrink-0" />
        </div>
      </div>
    </Button>
  );
}

function StatusBadge({
  label,
  variant,
}: Readonly<{ label: string; variant: 'green' | 'muted' | 'amber' }>): React.JSX.Element {
  const classes = {
    green: 'text-green-600 bg-green-50 dark:bg-green-950/30',
    muted: 'text-muted-foreground bg-muted',
    amber: 'text-amber-600 bg-amber-50 dark:bg-amber-950/30',
  };

  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${classes[variant]}`}
    >
      {label}
    </span>
  );
}

function TwoFactorSettingSection({
  totpEnabled,
}: Readonly<{ totpEnabled: boolean }>): React.JSX.Element {
  const [showTwoFactorSetup, setShowTwoFactorSetup] = useState(false);
  const [showDisable2FA, setShowDisable2FA] = useState(false);

  const handleTwoFactorSuccess = useCallback(() => {
    setShowTwoFactorSetup(false);
    const currentUser = useAuthStore.getState().user;
    if (currentUser) {
      useAuthStore.getState().setUser({ ...currentUser, totpEnabled: true });
    }
  }, []);

  const handleDisable2FASuccess = useCallback(() => {
    setShowDisable2FA(false);
    const currentUser = useAuthStore.getState().user;
    if (currentUser) {
      useAuthStore.getState().setUser({ ...currentUser, totpEnabled: false });
    }
  }, []);

  return (
    <>
      <SettingItem
        icon={Shield}
        title="Two-Factor Authentication"
        description={
          totpEnabled ? 'Manage your authentication security' : 'Add an extra layer of security'
        }
        onClick={() => {
          if (totpEnabled) {
            setShowDisable2FA(true);
          } else {
            setShowTwoFactorSetup(true);
          }
        }}
        statusBadge={
          totpEnabled ? (
            <StatusBadge label="Enabled" variant="green" />
          ) : (
            <StatusBadge label="Disabled" variant="muted" />
          )
        }
      />
      <TwoFactorSetup
        open={showTwoFactorSetup}
        onOpenChange={setShowTwoFactorSetup}
        onSuccess={handleTwoFactorSuccess}
      />
      <DisableTwoFactorModal
        open={showDisable2FA}
        onOpenChange={setShowDisable2FA}
        onSuccess={handleDisable2FASuccess}
      />
    </>
  );
}

function SettingsPage(): React.JSX.Element {
  const user = useAuthStore((s) => s.user);
  const customInstructions = useAuthStore((s) => s.customInstructions);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showRecoveryPhrase, setShowRecoveryPhrase] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [showCustomInstructions, setShowCustomInstructions] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);

  const handleCustomInstructionsSuccess = useCallback(() => {
    setShowCustomInstructions(false);
  }, []);

  const handleChangePasswordSuccess = useCallback(() => {
    setShowChangePassword(false);
  }, []);

  const handleRecoverySuccess = useCallback(() => {
    setShowRecoveryPhrase(false);
    const currentUser = useAuthStore.getState().user;
    if (currentUser) {
      useAuthStore.getState().setUser({ ...currentUser, hasAcknowledgedPhrase: true });
    }
  }, []);

  const changePasswordMutation = useChangePassword();
  const handleChangePasswordSubmit = useCallback(
    async (data: {
      currentPassword: string;
      newPassword: string;
    }): Promise<{ success: boolean; error?: string }> => {
      try {
        await changePasswordMutation.mutateAsync(data);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : undefined;
        return { success: false, ...(message !== undefined && { error: message }) };
      }
    },
    [changePasswordMutation]
  );

  const handleRecoveryClick = useCallback(() => {
    if (user?.hasAcknowledgedPhrase) {
      setShowRegenerateConfirm(true);
    } else {
      setShowRecoveryPhrase(true);
    }
  }, [user?.hasAcknowledgedPhrase]);

  const handleConfirmRegenerate = useCallback(() => {
    setShowRegenerateConfirm(false);
    setShowRecoveryPhrase(true);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" right={<ThemeToggle />} />

      <PageBody testId="settings-content" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-brand-red">Account</CardTitle>
            <CardDescription>Your account information</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-medium break-all">
              {user?.email}{' '}
              {user?.emailVerified ? (
                <StatusBadge label="Verified" variant="green" />
              ) : (
                <StatusBadge label="Not verified" variant="amber" />
              )}
            </p>
          </CardContent>
        </Card>

        <MailingListCard />

        <NotificationsCard />

        <Card>
          <CardHeader>
            <CardTitle className="text-brand-red">Preferences</CardTitle>
            <CardDescription>Customize how AI responds to you</CardDescription>
          </CardHeader>
          <CardContent>
            <SettingItem
              icon={MessageSquare}
              title="Custom Instructions"
              description="Tell the AI about yourself and how you'd like it to respond"
              onClick={() => {
                setShowCustomInstructions(true);
              }}
              statusBadge={
                customInstructions == null ? (
                  <StatusBadge label="Not set" variant="muted" />
                ) : (
                  <StatusBadge label="Active" variant="green" />
                )
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-brand-red">Security</CardTitle>
            <CardDescription>Manage authentication</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <SettingItem
              icon={Key}
              title="Change Password"
              description="Update your account password"
              onClick={() => {
                setShowChangePassword(true);
              }}
            />
            <TwoFactorSettingSection totpEnabled={user?.totpEnabled ?? false} />
            <SettingItem
              icon={FileText}
              title="Recovery Phrase"
              description="Protect from forgetting your password"
              onClick={handleRecoveryClick}
              statusBadge={
                user?.hasAcknowledgedPhrase ? (
                  <StatusBadge label="Enabled" variant="green" />
                ) : (
                  <StatusBadge label="Disabled" variant="muted" />
                )
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-brand-red">Legal</CardTitle>
            <CardDescription>Terms and policies</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <button
              type="button"
              onClick={() => void openExternalPage(ROUTES.TERMS)}
              className="flex items-center gap-3 text-sm hover:underline"
            >
              <Scale className="h-4 w-4" />
              Terms of Service
            </button>
            <button
              type="button"
              onClick={() => void openExternalPage(ROUTES.PRIVACY)}
              className="flex items-center gap-3 text-sm hover:underline"
            >
              <Shield className="h-4 w-4" />
              Privacy Policy
            </button>
            <p className="text-muted-foreground text-xs">
              Effective: {PRIVACY_POLICY_META.effectiveDate}
            </p>
          </CardContent>
        </Card>

        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">Danger zone</CardTitle>
            <CardDescription>
              Permanently delete your account and all associated data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="destructive"
              onClick={() => {
                setShowDeleteAccount(true);
              }}
              data-testid={TEST_IDS.deleteAccountTrigger}
            >
              Delete Account
            </Button>
          </CardContent>
        </Card>
      </PageBody>

      <DeleteAccountModal open={showDeleteAccount} onOpenChange={setShowDeleteAccount} />

      <CustomInstructionsModal
        open={showCustomInstructions}
        onOpenChange={setShowCustomInstructions}
        onSuccess={handleCustomInstructionsSuccess}
      />

      <RegenerateConfirmModal
        open={showRegenerateConfirm}
        onOpenChange={setShowRegenerateConfirm}
        onConfirm={handleConfirmRegenerate}
      />

      <ChangePasswordModal
        open={showChangePassword}
        onOpenChange={setShowChangePassword}
        onSuccess={handleChangePasswordSuccess}
        onSubmit={handleChangePasswordSubmit}
      />

      <RecoveryPhraseModal
        open={showRecoveryPhrase}
        onOpenChange={setShowRecoveryPhrase}
        onSuccess={handleRecoverySuccess}
      />
    </div>
  );
}
