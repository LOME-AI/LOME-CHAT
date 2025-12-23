import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import * as schema from '@lome-chat/db';
import type { Database } from '@lome-chat/db';
import type { EmailClient } from '../services/email/index.js';

export interface AuthConfig {
  db: Database;
  emailClient: EmailClient;
  baseUrl: string;
  secret: string;
}

export function createAuth(config: AuthConfig): ReturnType<typeof betterAuth> {
  return betterAuth({
    baseURL: config.baseUrl,
    secret: config.secret,
    database: drizzleAdapter(config.db, {
      provider: 'pg',
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        await config.emailClient.sendEmail({
          to: user.email,
          subject: 'Verify your email address',
          html: `
            <h1>Welcome to LOME-CHAT</h1>
            <p>Click the link below to verify your email address:</p>
            <a href="${url}">Verify Email</a>
          `,
        });
      },
    },
  });
}
