import * as React from 'react';
import { displayUsername, TEST_IDS } from '@hushbox/shared';
import { useModelStore } from '@/stores/model';
import { getTypingActivityLabel } from '@/lib/modality-strings';
import { DotPulseIndicator } from '@/components/chat/indicators/dot-pulse-indicator';
import type { LegacyModality } from '@hushbox/shared';

interface TypingIndicatorProps {
  typingUserIds: Set<string>;
  members: { userId: string | null; username: string | null }[];
}

function resolveUsername(
  userId: string,
  members: readonly { userId: string | null; username: string | null }[]
): string {
  const member = members.find((m) => m.userId === userId);
  return member?.username ? displayUsername(member.username) : 'Someone';
}

function buildSubject(
  typingUserIds: Set<string>,
  members: readonly { userId: string | null; username: string | null }[]
): { subject: string; plural: boolean } {
  const count = typingUserIds.size;
  if (count >= 3) {
    return { subject: `${String(count)} people`, plural: true };
  }
  const names = [...typingUserIds].map((id) => resolveUsername(id, members));
  if (count === 2) {
    /* v8 ignore next -- count === 2 guarantees names[0] exists and resolveUsername never returns undefined; the ?? only satisfies noUncheckedIndexedAccess */
    const first = names[0] ?? 'Someone';
    /* v8 ignore next -- count === 2 guarantees names[1] exists and resolveUsername never returns undefined; the ?? only satisfies noUncheckedIndexedAccess */
    const second = names[1] ?? 'Someone';
    return { subject: `${first} and ${second}`, plural: true };
  }
  /* v8 ignore next -- count === 1 here guarantees names[0] exists and resolveUsername never returns undefined; the ?? only satisfies noUncheckedIndexedAccess */
  const first = names[0] ?? 'Someone';
  return { subject: first, plural: false };
}

function formatTypingLabel(
  typingUserIds: Set<string>,
  members: readonly { userId: string | null; username: string | null }[],
  modality: LegacyModality
): string {
  const { subject, plural } = buildSubject(typingUserIds, members);
  return getTypingActivityLabel(modality, subject, plural);
}

export function TypingIndicator({
  typingUserIds,
  members,
}: Readonly<TypingIndicatorProps>): React.JSX.Element | null {
  const activeModality = useModelStore((state) => state.activeModality);

  if (typingUserIds.size === 0) {
    return null;
  }

  const label = formatTypingLabel(typingUserIds, members, activeModality);

  return (
    <div
      role="status"
      aria-label={label}
      data-testid={TEST_IDS.typingIndicator}
      className="text-foreground mb-2 flex items-center justify-center gap-1 text-sm"
    >
      <span>{label}</span>
      <DotPulseIndicator />
    </div>
  );
}
