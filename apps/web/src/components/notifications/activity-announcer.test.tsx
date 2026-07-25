import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { ActivityAnnouncer } from '@/components/notifications/activity-announcer';
import { useNotificationActivityStore } from '@/stores/notification-activity';

function setUnread(count: number): void {
  act(() => {
    useNotificationActivityStore.setState({ unreadCount: count });
  });
}

describe('ActivityAnnouncer', () => {
  beforeEach(() => {
    useNotificationActivityStore.setState({ unreadCount: 0 });
  });

  it('announces politely, without stealing focus', () => {
    render(<ActivityAnnouncer />);

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(document.activeElement).toBe(document.body);
  });

  it('says nothing while there is nothing unread', () => {
    render(<ActivityAnnouncer />);

    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('announces a single arrival in the singular', () => {
    render(<ActivityAnnouncer />);

    setUnread(1);

    expect(screen.getByRole('status')).toHaveTextContent('1 new notification');
  });

  it('announces several arrivals in the plural', () => {
    render(<ActivityAnnouncer />);

    setUnread(4);

    expect(screen.getByRole('status')).toHaveTextContent('4 new notifications');
  });
});
