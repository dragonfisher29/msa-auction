import path from 'path';
import { test, expect } from '@playwright/test';
import { mockApi } from './fixtures/mockApi';

const IMAGES_DIR = path.resolve(process.cwd(), 'docs/images');

test.describe('documentation screenshots', () => {
  test('01 - homepage dashboard with the populated auction grid', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await expect(page.locator('#auction-card-auc_macbook')).toBeVisible();
    await expect(page.locator('header')).toContainText('Live');

    await page.screenshot({ path: path.join(IMAGES_DIR, '01-homepage.png'), fullPage: true });
  });

  test('02 - auth modal, Sign In tab', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await page.locator('#sign-in-btn').click();
    await expect(page.locator('#tab-login-btn')).toBeVisible();
    await expect(page.locator('#auth-username-input')).toBeVisible();

    await page.screenshot({ path: path.join(IMAGES_DIR, '02-sign-in.png'), fullPage: true });
  });

  test('03 - Create Listing form, partially filled', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    // Sign in first so the form reflects the normal signed-in creation flow.
    await page.locator('#sign-in-btn').click();
    await page.locator('#auth-username-input').fill('ellie');
    await page.locator('#auth-password-input').fill('correct-horse-battery-staple');
    await page.locator('#auth-submit-btn').click();
    await expect(page.locator('#close-auth-modal-btn')).toHaveCount(0);

    await page.locator('#create-listing-header-btn').click();
    await expect(page.locator('#listing-title-input')).toBeVisible();

    await page.locator('#listing-title-input').fill('Casio FX-991EX Scientific Calculator');
    await page.locator('#listing-description-input').fill('Barely used, exam-approved, comes with the manual and a spare battery.');
    await page.locator('#listing-starting-price-input').fill('15');

    await page.screenshot({ path: path.join(IMAGES_DIR, '03-create-listing.png'), fullPage: true });
  });

  test('04 - auction detail modal with price, countdown, and bid history', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await page.locator('#view-auction-btn-auc_canon').click();
    await expect(page.locator('#place-bid-amount-input')).toBeVisible();
    await expect(page.getByText(/Live Bid History/i)).toBeVisible();

    await page.screenshot({ path: path.join(IMAGES_DIR, '04-auction-detail.png'), fullPage: true });
  });

  test('05 - bid form with an amount entered and quick-increment buttons visible', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await page.locator('#view-auction-btn-auc_macbook').click();
    await expect(page.locator('#place-bid-amount-input')).toBeVisible();

    // Bump the pre-filled suggested bid using a quick-increment pill, then top it up manually.
    await page.getByRole('button', { name: '+£10', exact: true }).click();
    await page.locator('#place-bid-amount-input').fill('700');

    await page.screenshot({ path: path.join(IMAGES_DIR, '05-place-bid.png'), fullPage: true });
  });

  test('06 - search, category, and status filters applied together', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await page.locator('#search-auctions-input').fill('Camera');
    await page.locator('#category-btn-electronics').click();
    await page.locator('#filter-tab-active').click();

    await expect(page.locator('#auction-card-auc_canon')).toBeVisible();

    await page.screenshot({ path: path.join(IMAGES_DIR, '06-search-filters.png'), fullPage: true });
  });
});
