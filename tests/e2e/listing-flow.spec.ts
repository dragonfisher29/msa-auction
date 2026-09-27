import { test, expect, type Page } from '@playwright/test';
import { mockApi } from './fixtures/mockApi';
import { browseableDemoAuctions, demoAuctions } from './fixtures/auctions';

// A valid 1x1 PNG, so the real in-browser compression path (canvas -> JPEG) runs on upload.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function signIn(page: Page) {
  await page.locator('#sign-in-btn').click();
  await expect(page.locator('#tab-login-btn')).toBeVisible();
  await page.locator('#auth-username-input').fill('ellie');
  await page.locator('#auth-password-input').fill('correct-horse-battery-staple');
  await page.locator('#auth-submit-btn').click();
  await expect(page.locator('#close-auth-modal-btn')).toHaveCount(0);
}

test.describe('browse page', () => {
  test('shows every listing still for sale and nothing sold, newest first', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    for (const auction of browseableDemoAuctions) {
      await expect(page.locator(`#auction-card-${auction.id}`)).toBeVisible();
    }
    await expect(page.locator('#auction-card-auc_lotr')).toHaveCount(0);

    const newestFirst = [...browseableDemoAuctions].sort((a, b) => b.createdAt - a.createdAt).map((a) => a.title);
    await expect(page.locator('[id^="auction-card-"] h3')).toHaveText(newestFirst);
  });

  test('cards show price, seller and age -- and no bidding or live-feed language', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    const jacket = page.locator('#auction-card-auc_jacket');
    await expect(jacket).toContainText('£24.50');
    await expect(jacket).toContainText('George Popescu');
    await expect(jacket).toContainText('Listed 20 days ago');

    const body = page.locator('body');
    await expect(body).not.toContainText(/\bbids?\b|bidder|real-time|bi-directional|ending soon/i);
    await expect(page.getByTestId('connection-status')).toHaveCount(0);
  });

  test('sorts by price in both directions', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await expect(page.locator('#auction-card-auc_macbook')).toBeVisible();

    const byPrice = [...browseableDemoAuctions].sort((a, b) => a.price - b.price).map((a) => a.title);

    const titles = page.locator('[id^="auction-card-"] h3');

    await page.locator('#sort-auctions-select').selectOption('price_low');
    await expect(titles).toHaveText(byPrice);

    await page.locator('#sort-auctions-select').selectOption('price_high');
    await expect(titles).toHaveText([...byPrice].reverse());
  });

  test('the category filter narrows the grid to the selected category', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await page.locator('#category-btn-electronics').click();

    for (const auction of browseableDemoAuctions) {
      await expect(page.locator(`#auction-card-${auction.id}`)).toHaveCount(auction.category === 'Electronics' ? 1 : 0);
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

  test('never polls /api/health, and an open detail modal does not poll its listing', async ({ page }) => {
    const { requests } = await mockApi(page);
    await page.goto('/');
    await signIn(page);

    await page.locator('#view-auction-btn-auc_desk').click();
    await expect(page.locator('#contact-whatsapp-btn')).toBeVisible();

    // Counted after the modal has settled rather than as absolute numbers: the Vite dev server
    // runs React StrictMode, which mounts every effect twice, so each one-off fetch is doubled
    // here (and single in a production build). What matters is that nothing repeats over time.
    const detailFetches = () => requests.filter((r) => r.method === 'GET' && r.pathname === '/api/auctions/auc_desk').length;
    const feedFetches = () => requests.filter((r) => r.method === 'GET' && r.pathname === '/api/auctions').length;
    const detailBefore = detailFetches();
    const feedBefore = feedFetches();

    // The old modal re-fetched every 3s, the old feed every 5s, and the header pinged
    // /api/health every 15s.
    await page.waitForTimeout(6000);

    expect(requests.filter((r) => r.pathname === '/api/health')).toHaveLength(0);
    expect(detailFetches()).toBe(detailBefore);
    expect(feedFetches()).toBe(feedBefore);
  });
});

test.describe('contacting a seller', () => {
  test('signed out: the detail modal offers "Sign in to contact the seller", and signing in reveals WhatsApp', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await page.locator('#view-auction-btn-auc_desk').click();
    await expect(page.locator('#listing-detail-price')).toHaveText('£60');
    await expect(page.locator('#contact-whatsapp-btn')).toHaveCount(0);

    await page.getByRole('button', { name: 'Sign in to contact the seller' }).click();
    await expect(page.locator('#tab-login-btn')).toBeVisible();
    await page.locator('#auth-username-input').fill('ellie');
    await page.locator('#auth-password-input').fill('correct-horse-battery-staple');
    await page.locator('#auth-submit-btn').click();

    const whatsApp = page.locator('#contact-whatsapp-btn');
    await expect(whatsApp).toBeVisible();
    await expect(whatsApp).toHaveAttribute(
      'href',
      `https://wa.me/447700900444?text=${encodeURIComponent('Hi, I\'m interested in "IKEA Desk & Ergonomic Chair Bundle" on MSA Auction.')}`,
    );
    await expect(whatsApp).toHaveAttribute('target', '_blank');
    await expect(whatsApp).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('a deep link to a sold listing renders a clear sold state with no contact button', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await signIn(page);
    await page.goto('/auction/auc_lotr');

    await expect(page.locator('#listing-status-pill')).toHaveText('Sold');
    await expect(page.locator('#listing-status-banner')).toContainText('This item has been sold');
    await expect(page.locator('#contact-whatsapp-btn')).toHaveCount(0);
  });

  test('a deep link to a listing that no longer exists says so instead of showing the bare grid', async ({ page }) => {
    await mockApi(page);
    await page.goto('/auction/auc_does_not_exist');

    const notice = page.getByRole('dialog', { name: 'This listing is no longer available' });
    await expect(notice).toBeVisible();

    await notice.getByRole('button', { name: 'Browse Listings' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#auction-card-auc_macbook')).toBeVisible();
  });
});

test.describe('selling', () => {
  test('the owner marks a listing as sold after confirming, and it leaves the browse page', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await signIn(page);

    await page.locator('#view-auction-btn-auc_ellie_lamp').click();
    // The owner sees their own controls, not a contact button.
    await expect(page.locator('#contact-whatsapp-btn')).toHaveCount(0);
    await page.locator('#mark-sold-btn-auc_ellie_lamp').click();

    const soldRequest = page.waitForRequest(
      (req) => req.method() === 'POST' && req.url().endsWith('/api/auctions/auc_ellie_lamp/sold'),
    );
    await page.locator('#mark-sold-confirm-btn').click();
    await soldRequest;

    await expect(page.locator('#listing-status-banner')).toContainText('This item has been sold');
    await expect(page.locator('#mark-sold-btn-auc_ellie_lamp')).toHaveCount(0);

    await page.locator('#close-auction-detail-btn').click();
    await expect(page.locator('#auction-card-auc_ellie_lamp')).toHaveCount(0);
  });

  test('creating a listing sends a single fixed price and no auction fields', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await signIn(page);

    await page.locator('#create-listing-header-btn').click();
    await expect(page.locator('#listing-lifetime-note')).toContainText('30 days');
    await expect(page.locator('#listing-starting-price-input')).toHaveCount(0);

    await page.locator('#listing-title-input').fill('Casio FX-991EX Scientific Calculator');
    await page.locator('#listing-description-input').fill('Barely used, exam-approved, comes with the manual.');
    await page.locator('#listing-price-input').fill('12.50');
    await page.locator('#listing-phone-input').fill('+44 7700 900123');
    await page.locator('#listing-images-input').setInputFiles({ name: 'calc.png', mimeType: 'image/png', buffer: TINY_PNG });
    await expect(page.locator('#submit-create-listing-btn')).toBeEnabled();

    const createRequest = page.waitForRequest((req) => req.method() === 'POST' && req.url().endsWith('/api/auctions'));
    await page.locator('#submit-create-listing-btn').click();
    const body = (await createRequest).postDataJSON();

    expect(body.price).toBe(12.5);
    expect(body).not.toHaveProperty('startingPrice');
    expect(body).not.toHaveProperty('durationMinutes');

    // The new listing opens straight away, priced as entered.
    await expect(page.locator('#listing-detail-price')).toHaveText('£12.50');
  });

  test('a zero price is refused before anything is sent', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await signIn(page);

    await page.locator('#create-listing-header-btn').click();
    await page.locator('#listing-title-input').fill('Kettle');
    await page.locator('#listing-description-input').fill('Works.');
    await page.locator('#listing-phone-input').fill('+44 7700 900123');
    await page.locator('#listing-price-input').fill('0');
    await page.locator('#submit-create-listing-btn').click();

    // The browser's own constraint validation (min=0.01) stops the submit before the app sees it.
    const valid = await page.locator('#listing-price-input').evaluate((el: HTMLInputElement) => el.validity.valid);
    expect(valid).toBe(false);
  });
});

test('fixtures include a sold listing so the sold paths above are exercised', () => {
  expect(demoAuctions.some((a) => a.status === 'sold')).toBe(true);
});
