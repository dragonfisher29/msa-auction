import path from 'path';
import { test, expect, type Page } from '@playwright/test';
import { mockApi } from './fixtures/mockApi';

// Defaults to the README's tutorial images. Set SCREENSHOT_DIR to render somewhere else (e.g. a
// scratch folder) to check the flows still work without touching the committed images.
const IMAGES_DIR = process.env.SCREENSHOT_DIR
  ? path.resolve(process.env.SCREENSHOT_DIR)
  : path.resolve(process.cwd(), 'docs/images');

async function signIn(page: Page) {
  await page.locator('#sign-in-btn').click();
  await page.locator('#auth-username-input').fill('ellie');
  await page.locator('#auth-password-input').fill('correct-horse-battery-staple');
  await page.locator('#auth-submit-btn').click();
  await expect(page.locator('#close-auth-modal-btn')).toHaveCount(0);
}

test.describe('documentation screenshots', () => {
  test('01 - browse page with the populated listing grid', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await expect(page.locator('#auction-card-auc_macbook')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Browse Listings' })).toBeVisible();

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
    await signIn(page);

    await page.locator('#create-listing-header-btn').click();
    await expect(page.locator('#listing-title-input')).toBeVisible();

    await page.locator('#listing-title-input').fill('Casio FX-991EX Scientific Calculator');
    await page.locator('#listing-description-input').fill('Barely used, exam-approved, comes with the manual and a spare battery.');
    await page.locator('#listing-price-input').fill('15');
    await page.locator('#listing-phone-input').fill('+44 7700 900123');

    await page.screenshot({ path: path.join(IMAGES_DIR, '03-create-listing.png'), fullPage: true });
  });

  test('04 - listing detail modal with price and the WhatsApp contact button', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await signIn(page);

    await page.locator('#view-auction-btn-auc_canon').click();
    await expect(page.locator('#listing-detail-price')).toBeVisible();
    await expect(page.locator('#contact-whatsapp-btn')).toBeVisible();

    await page.screenshot({ path: path.join(IMAGES_DIR, '04-auction-detail.png'), fullPage: true });
  });

  test('05 - seller marking their own listing as sold', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await signIn(page);

    await page.locator('#view-auction-btn-auc_ellie_lamp').click();
    await page.locator('#mark-sold-btn-auc_ellie_lamp').click();
    await expect(page.locator('#mark-sold-confirm-btn')).toBeVisible();

    await page.screenshot({ path: path.join(IMAGES_DIR, '05-mark-sold.png'), fullPage: true });
  });

  test('06 - search, category filter and sort applied together', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await page.locator('#search-auctions-input').fill('Camera');
    await page.locator('#category-btn-electronics').click();
    await page.locator('#sort-auctions-select').selectOption('price_low');

    await expect(page.locator('#auction-card-auc_canon')).toBeVisible();

    await page.screenshot({ path: path.join(IMAGES_DIR, '06-search-filters.png'), fullPage: true });
  });
});
