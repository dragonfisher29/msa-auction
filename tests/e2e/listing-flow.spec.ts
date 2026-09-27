import { test, expect } from '@playwright/test';
import { mockApi } from './fixtures/mockApi';
import { demoAuctions } from './fixtures/auctions';

async function signIn(page: import('@playwright/test').Page) {
  await page.locator('#sign-in-btn').click();
  await expect(page.locator('#tab-login-btn')).toBeVisible();
  await page.locator('#auth-username-input').fill('ellie');
  await page.locator('#auth-password-input').fill('correct-horse-battery-staple');
  await page.locator('#auth-submit-btn').click();
  await expect(page.locator('#close-auth-modal-btn')).toHaveCount(0);
}

test.describe('auction dashboard', () => {
  test('shows a live connection status and never the old "Connecting to Server..." string', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    const connectionStatus = page.getByTestId('connection-status');
    await expect(connectionStatus).toContainText('Live');
    await expect(connectionStatus).not.toContainText('Reconnecting...');
    await expect(page.getByText('Connecting to Server...')).toHaveCount(0);
  });

  test('renders every fixture listing in the auction grid', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    for (const auction of demoAuctions) {
      await expect(page.locator(`#auction-card-${auction.id}`)).toBeVisible();
    }
  });

  test('the category filter narrows the grid to the selected category', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await page.locator('#category-btn-electronics').click();

    const electronics = demoAuctions.filter((a) => a.category === 'Electronics');
    const others = demoAuctions.filter((a) => a.category !== 'Electronics');

    for (const auction of electronics) {
      await expect(page.locator(`#auction-card-${auction.id}`)).toBeVisible();
    }
    for (const auction of others) {
      await expect(page.locator(`#auction-card-${auction.id}`)).toHaveCount(0);
    }
  });

  test('the search box filters the grid by title', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await page.locator('#search-auctions-input').fill('Trek Marlin');

    await expect(page.locator('#auction-card-auc_bike')).toBeVisible();
    await expect(page.locator('#auction-card-auc_macbook')).toHaveCount(0);
    await expect(page.locator('#auction-card-auc_desk')).toHaveCount(0);
  });

  test('opening a card shows the detail modal with a bid form', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await page.locator('#view-auction-btn-auc_desk').click();

    await expect(page.locator('#place-bid-amount-input')).toBeVisible();
    await expect(page.locator('#place-bid-submit-btn')).toBeVisible();
  });

  test('placing a valid bid issues a POST to /api/auctions/:id/bids', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await signIn(page);

    await page.locator('#view-auction-btn-auc_desk').click();
    await expect(page.locator('#place-bid-amount-input')).toBeVisible();

    const bidRequest = page.waitForRequest(
      (req) => req.method() === 'POST' && req.url().endsWith('/api/auctions/auc_desk/bids'),
    );
    await page.locator('#place-bid-submit-btn').click();
    const request = await bidRequest;

    // The bidder is identified by the bearer token server-side now -- userId/userName are no
    // longer part of the request body at all (see the comment in AuctionDetailModal's
    // handlePlaceBid), so the only thing left to assert on the payload is the amount.
    const payload = request.postDataJSON();
    expect(payload).toEqual({ amount: expect.any(Number) });

    await expect(page.getByText(/Placed bid of/i)).toBeVisible();
  });

  test('a mocked 400 bid response surfaces the server error text in the UI', async ({ page }) => {
    await mockApi(page, {
      bidOverrideByAuctionId: {
        auc_desk: { status: 400, body: { error: 'Someone beat you to it, please refresh and try again.' } },
      },
    });
    await page.goto('/');

    await signIn(page);

    await page.locator('#view-auction-btn-auc_desk').click();
    await expect(page.locator('#place-bid-amount-input')).toBeVisible();
    await page.locator('#place-bid-submit-btn').click();

    await expect(page.getByText('Someone beat you to it, please refresh and try again.')).toBeVisible();
    await expect(page.getByText(/Placed bid of/i)).toHaveCount(0);
  });
});
