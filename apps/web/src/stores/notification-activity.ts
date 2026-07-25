import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isAwayFromApp } from '@/lib/notification-activity/app-attention';
import { primeNotificationSound } from '@/lib/notification-activity/sound';

/**
 * One observed notification-worthy event, whatever channel carried it. The
 * count is app-wide, so an event carries no identity — only whether it should
 * be counted at all.
 */
interface ActivityEvent {
  /**
   * True when this user caused the event (their own send echoed back to this
   * device). Their own activity is never activity to be told about.
   */
  readonly selfAuthored?: boolean;
}

interface NotificationActivityState {
  /**
   * Events observed while the user was looking away, since they last looked
   * back. Deliberately not a durable unread count: it starts at zero every
   * session and no server truth feeds it.
   */
  unreadCount: number;
  /** Opt-in chime on incoming activity. Off until the user turns it on. */
  soundEnabled: boolean;
  recordActivity: (event?: ActivityEvent) => void;
  markAllSeen: () => void;
  setSoundEnabled: (enabled: boolean) => void;
}

export const useNotificationActivityStore = create<NotificationActivityState>()(
  persist(
    (set) => ({
      unreadCount: 0,
      soundEnabled: false,

      recordActivity: (event) => {
        if (event?.selfAuthored === true) return;
        if (!isAwayFromApp()) return;
        set((state) => ({ unreadCount: state.unreadCount + 1 }));
      },

      markAllSeen: () => {
        set({ unreadCount: 0 });
      },

      setSoundEnabled: (enabled) => {
        // Runs synchronously inside the click that flipped the control, which is
        // the interaction browsers require before audio may play unprompted.
        if (enabled) primeNotificationSound();
        set({ soundEnabled: enabled });
      },
    }),
    {
      name: 'hushbox-notification-activity',
      // The count is per-session by design; only the preference is durable.
      partialize: (state) => ({ soundEnabled: state.soundEnabled }),
    }
  )
);
