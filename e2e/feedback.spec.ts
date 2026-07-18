import { expect, test } from './fixtures.js';
import {
  clearAuthRateLimits,
  signUpAndVerify,
  uniqueEmail,
  uniqueUsername,
} from './helpers/auth.js';
import { fetchFeedbackByEmail, openFeedbackModal, submitFeedback } from './helpers/feedback.js';

const FRESH_PASSWORD = 'TestPassword123!';

/**
 * A logged-in user sends feedback and the row is proven to persist. The UI
 * submit is gated on app state (the `POST /feedback` 200 and the success
 * toast), and the persistence is proven through the dev read-back route — the
 * side effect, not just the UI (rule 1.5).
 */
test.describe('Feedback', () => {
  test('a logged-in user sends bug feedback and the row lands in Postgres', async ({
    page,
    request,
  }) => {
    await clearAuthRateLimits(request);
    const email = uniqueEmail('fb');
    const username = uniqueUsername('fb');
    await signUpAndVerify(page, request, { username, email, password: FRESH_PASSWORD });

    const body = `E2E feedback ${crypto.randomUUID()}`;
    await openFeedbackModal(page);
    await submitFeedback(page, { kind: 'bug', body });

    // Side-effect proof: the submitted note is now a real row for this user.
    const rows = await fetchFeedbackByEmail(request, email);
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'bug', body }));
  });
});
