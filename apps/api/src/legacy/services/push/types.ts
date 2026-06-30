export interface PushNotification {
  tokens: string[];
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushResult {
  successCount: number;
  failureCount: number;
}

export interface PushClient {
  send(notification: PushNotification): Promise<PushResult>;
}

export interface MockPushClient extends PushClient {
  getSentNotifications(): PushNotification[];
  clearSentNotifications(): void;
}
