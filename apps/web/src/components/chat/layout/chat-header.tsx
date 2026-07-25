import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { EncryptionBadge } from '@/components/shared/encryption-badge';
import { PageHeader } from '@/components/shared/page-header';
import { ModelSelectorButton } from '@/components/chat/model-selector/model-selector-button';
import { MemberFacepile } from '@/components/chat/member/member-facepile';
import type { Model, ChatModality } from '@hushbox/shared';
import type { SelectedModelEntry } from '@/stores/model';
import type { ModelFloorGroupContext } from '@/hooks/billing/use-prompt-budget';
import type { ModelSelectorGatingProps } from '@/components/chat/model-selector/model-selector-types';

interface ChatHeaderProps extends ModelSelectorGatingProps {
  models: Model[];
  selectedModels: SelectedModelEntry[];
  onModelSelect: (models: SelectedModelEntry[]) => void;
  title?: string | undefined;
  /** Members for facepile display (undefined = no group chat features shown).
   *  Link-guest members carry null userId/username (see GroupChatProps.members). */
  members?: { id: string; userId: string | null; username: string | null }[] | undefined;
  /** Set of online member IDs from WebSocket presence */
  onlineMemberIds?: Set<string> | undefined;
  /** Called when facepile is clicked (opens member list) */
  onFacepileClick?: (() => void) | undefined;
  activeModality?: ChatModality;
  /** Controlled open state for the picker, lifted so siblings can trigger it. */
  pickerOpen?: boolean | undefined;
  /** Called when the picker should open or close. */
  onPickerOpenChange?: ((open: boolean) => void) | undefined;
  /** Group funding context for the picker's affordability floor (threading only). */
  floorGroup?: ModelFloorGroupContext | undefined;
}

export function ChatHeader({
  models,
  selectedModels,
  onModelSelect,
  title,
  premiumIds,
  canAccessPremium,
  isAuthenticated,
  isLinkGuest,
  onPremiumClick,
  members,
  onlineMemberIds,
  onFacepileClick,
  activeModality = 'text',
  pickerOpen,
  onPickerOpenChange,
  floorGroup,
}: Readonly<ChatHeaderProps>): React.JSX.Element {
  const showGroupFeatures = members !== undefined && members.length > 0;

  return (
    <PageHeader
      testId={TEST_IDS.chatHeader}
      titleTestId={TEST_IDS.chatTitle}
      title={title}
      brandTitle={true}
      center={
        <ModelSelectorButton
          models={models}
          selectedModels={selectedModels}
          onSelect={onModelSelect}
          premiumIds={premiumIds}
          canAccessPremium={canAccessPremium}
          isAuthenticated={isAuthenticated}
          isLinkGuest={isLinkGuest}
          onPremiumClick={onPremiumClick}
          activeModality={activeModality}
          open={pickerOpen}
          onOpenChange={onPickerOpenChange}
          floorGroup={floorGroup}
        />
      }
      right={
        <div className="flex items-center gap-2">
          <EncryptionBadge isAuthenticated={isAuthenticated !== false} />
          <ThemeToggle />
          {showGroupFeatures && (
            <MemberFacepile
              members={members}
              onlineMemberIds={onlineMemberIds ?? new Set()}
              onFacepileClick={
                onFacepileClick ??
                (() => {
                  /* noop */
                })
              }
            />
          )}
        </div>
      }
    />
  );
}
