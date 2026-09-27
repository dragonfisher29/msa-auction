import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreateListingModal } from '../../src/components/CreateListingModal';
import { AuctionItem, User } from '../../src/types';

vi.mock('../../src/lib/api', () => {
  const apiFetch = vi.fn();
  return {
    apiFetch,
    resolveApiUrl: (path: string) => path,
    // Mirrors the real helper in src/lib/api.ts so the assertions below observe the request
    // exactly as it goes to the network, Authorization header included, through the single
    // apiFetch spy.
    apiFetchAuthed: (input: string, token: string | null | undefined, init?: RequestInit) =>
      apiFetch(input, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }),
  };
});

// Compression and upload go through canvas/network APIs jsdom doesn't implement, so the image
// pipeline in src/lib/images.ts is mocked here the same way src/lib/api.ts is above: real
// exports (the `ImageUploadError` class, the accepted-types label) pass through via
// `importActual`, and only the browser/network-touching functions are replaced with spies each
// test configures directly.
vi.mock('../../src/lib/images', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/images')>('../../src/lib/images');
  return {
    ...actual,
    compressImageToBlob: vi.fn(async (file: File) => new Blob(['compressed'], { type: file.type || 'image/jpeg' })),
    uploadImage: vi.fn(),
    createPreviewUrl: vi.fn((file: File) => `blob:mock-preview/${file.name}`),
    revokePreviewUrl: vi.fn(),
  };
});

import { apiFetch } from '../../src/lib/api';
import { compressImageToBlob, uploadImage, ImageUploadError } from '../../src/lib/images';

const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedCompressImageToBlob = compressImageToBlob as unknown as ReturnType<typeof vi.fn>;
const mockedUploadImage = uploadImage as unknown as ReturnType<typeof vi.fn>;

function makeImageFile(name = 'photo.jpg', type = 'image/jpeg'): File {
  return new File(['fake-bytes'], name, { type });
}

const NOW = Date.now();

const seller: User = {
  id: 'seller_1',
  name: 'Sam Seller',
  username: 'sam_seller',
  token: 'tok_seller',
  createdAt: NOW - 60 * 60 * 1000,
};

/** A full row, as returned by `GET /api/auctions/:id` -- always carries `imageUrls`. */
function makeFullAuction(overrides: Partial<AuctionItem> = {}): AuctionItem {
  return {
    id: 'auc_1',
    title: 'Vintage Film Camera',
    description: 'A well-loved vintage film camera, fully functional.',
    phoneNumber: '+44 7700 900000',
    price: 100,
    sellerId: seller.id,
    sellerName: seller.name,
    status: 'active',
    expiresAt: NOW + 20 * 24 * 60 * 60 * 1000,
    soldAt: null,
    category: 'Collectibles',
    imageUrl: 'https://example.test/camera-1.jpg',
    imageUrls: ['https://example.test/camera-1.jpg', 'https://example.test/camera-2.jpg'],
    createdAt: NOW - 10 * 60 * 1000,
    ...overrides,
  };
}

/**
 * A row shaped like one from `GET /api/users/me/activity`: the real text fields, but only
 * `imageCount` for images -- no `imageUrls`/`imageUrl` at all. This is what AccountView's "My
 * Listings" hands to the modal, and is the exact shape that produced the empty-`imageUrls` bug.
 */
function makePartialAuction(overrides: Partial<AuctionItem> = {}): AuctionItem {
  const full = makeFullAuction(overrides);
  const { imageUrl, imageUrls, ...rest } = full;
  return { ...rest, imageCount: imageUrls?.length ?? 0 } as AuctionItem;
}

function renderEditModal(initialAuction: AuctionItem, overrides: Partial<Parameters<typeof CreateListingModal>[0]> = {}) {
  const onClose = vi.fn();
  const onPromptAuth = vi.fn();
  const onCreated = vi.fn();
  const onUpdated = vi.fn();

  render(
    <CreateListingModal
      isOpen={true}
      user={seller}
      mode="edit"
      initialAuction={initialAuction}
      onClose={onClose}
      onCreated={onCreated}
      onUpdated={onUpdated}
      onPromptAuth={onPromptAuth}
      {...overrides}
    />,
  );

  return { onClose, onPromptAuth, onCreated, onUpdated };
}

function renderCreateModal(overrides: Partial<Parameters<typeof CreateListingModal>[0]> = {}) {
  const onClose = vi.fn();
  const onPromptAuth = vi.fn();
  const onCreated = vi.fn();
  const onUpdated = vi.fn();

  render(
    <CreateListingModal
      isOpen={true}
      user={seller}
      onClose={onClose}
      onCreated={onCreated}
      onUpdated={onUpdated}
      onPromptAuth={onPromptAuth}
      {...overrides}
    />,
  );

  return { onClose, onPromptAuth, onCreated, onUpdated };
}

function submitBtn(): HTMLButtonElement {
  return document.getElementById('submit-create-listing-btn') as HTMLButtonElement;
}

function imagesInput(): HTMLInputElement {
  return document.getElementById('listing-images-input') as HTMLInputElement;
}

/** Fills in every other required field so a test can focus purely on the image flow. */
async function fillRequiredNonImageFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(document.getElementById('listing-title-input') as HTMLInputElement, 'Retro Lamp');
  await user.type(
    document.getElementById('listing-description-input') as HTMLInputElement,
    'A working retro desk lamp, no chips or cracks.',
  );
  await user.type(document.getElementById('listing-phone-input') as HTMLInputElement, '+44 7700 900456');
  await user.type(priceInput(), '25');
}

function priceInput(): HTMLInputElement {
  return document.getElementById('listing-price-input') as HTMLInputElement;
}

describe('CreateListingModal (edit mode)', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it('fetches the full listing when initialAuction lacks imageUrls, and PATCHes the real images -- not an empty array', async () => {
    const partial = makePartialAuction();
    const full = makeFullAuction();

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/auctions/${partial.id}` && (!init || !init.method)) {
        return { ok: true, status: 200, json: async () => ({ auction: full }) } as Response;
      }
      if (url === `/api/auctions/${partial.id}` && init?.method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ auction: { ...full, title: 'Updated title' } }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    const { onUpdated } = renderEditModal(partial);

    // The fetch resolves and the loading state clears.
    await waitFor(() => expect(document.getElementById('edit-listing-loading')).toBeNull());
    expect(submitBtn()).not.toBeDisabled();

    const user = userEvent.setup();
    await user.click(submitBtn());

    await waitFor(() => {
      const patchCall = mockedApiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body.imageUrls).toEqual(full.imageUrls);
      expect(body.imageUrls.length).toBeGreaterThan(0);
    });

    expect(onUpdated).toHaveBeenCalled();
  });

  it('disables submit while the full-record fetch is in flight', async () => {
    const partial = makePartialAuction();
    let resolveGet: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveGet = resolve;
    });

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/auctions/${partial.id}` && (!init || !init.method)) {
        return pending;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    renderEditModal(partial);

    expect(document.getElementById('edit-listing-loading')).toBeInTheDocument();
    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent('Loading...');

    await act(async () => {
      resolveGet({ ok: true, status: 200, json: async () => ({ auction: makeFullAuction() }) } as Response);
      await pending;
    });

    await waitFor(() => expect(submitBtn()).not.toBeDisabled());
    expect(document.getElementById('edit-listing-loading')).toBeNull();
  });

  it('shows an error and keeps submit disabled when the full-record fetch fails', async () => {
    const partial = makePartialAuction();

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/auctions/${partial.id}` && (!init || !init.method)) {
        return { ok: false, status: 500, json: async () => ({ error: 'Failed to load auction.' }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    renderEditModal(partial);

    expect(await screen.findByText(/Could not load the current listing details/i)).toBeInTheDocument();
    expect(submitBtn()).toBeDisabled();

    // Confirms the guard actually blocks the network call too, not just the disabled attribute.
    expect(mockedApiFetch).not.toHaveBeenCalledWith(
      `/api/auctions/${partial.id}`,
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('round-trips a title-only edit without touching the images', async () => {
    const partial = makePartialAuction();
    const full = makeFullAuction();

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/auctions/${partial.id}` && (!init || !init.method)) {
        return { ok: true, status: 200, json: async () => ({ auction: full }) } as Response;
      }
      if (url === `/api/auctions/${partial.id}` && init?.method === 'PATCH') {
        const body = JSON.parse(init!.body as string);
        return { ok: true, status: 200, json: async () => ({ auction: { ...full, ...body } }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    renderEditModal(partial);

    await waitFor(() => expect(submitBtn()).not.toBeDisabled());

    const titleInput = document.getElementById('listing-title-input') as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(titleInput);
    await user.type(titleInput, 'A brand new title');
    await user.click(submitBtn());

    await waitFor(() => {
      const patchCall = mockedApiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body.title).toBe('A brand new title');
      expect(body.imageUrls).toEqual(full.imageUrls);
      expect(body.imageUrls.length).toBeGreaterThan(0);
    });
  });

  it('does not re-fetch when initialAuction already carries imageUrls (e.g. from AuctionDetailModal)', async () => {
    const full = makeFullAuction();

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/auctions/${full.id}` && init?.method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ auction: full }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    renderEditModal(full);

    // No GET was ever issued -- the passed-in object was already complete.
    expect(mockedApiFetch).not.toHaveBeenCalled();
    expect(document.getElementById('edit-listing-loading')).toBeNull();
    expect(submitBtn()).not.toBeDisabled();
  });

  it('does not reset a typed title when the parent re-renders with a new initialAuction object of the same id', async () => {
    const full = makeFullAuction();

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    const { rerender } = render(
      <CreateListingModal
        isOpen={true}
        user={seller}
        mode="edit"
        initialAuction={full}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onUpdated={vi.fn()}
        onPromptAuth={vi.fn()}
      />,
    );

    await waitFor(() => expect(submitBtn()).not.toBeDisabled());

    const titleInput = document.getElementById('listing-title-input') as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(titleInput);
    await user.type(titleInput, 'My unsaved edit');

    // A new object, same id -- what the detail modal's own fetch or a feed refresh produces: a
    // freshly-parsed response body, not the same reference, for the same listing.
    const polled = { ...full, price: full.price + 10 };
    rerender(
      <CreateListingModal
        isOpen={true}
        user={seller}
        mode="edit"
        initialAuction={polled}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onUpdated={vi.fn()}
        onPromptAuth={vi.fn()}
      />,
    );

    expect(titleInput.value).toBe('My unsaved edit');
  });

  it('repopulates the form when initialAuction changes to a genuinely different listing id', async () => {
    const full = makeFullAuction();
    const other = makeFullAuction({ id: 'auc_2', title: 'A Different Listing' });

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    const { rerender } = render(
      <CreateListingModal
        isOpen={true}
        user={seller}
        mode="edit"
        initialAuction={full}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onUpdated={vi.fn()}
        onPromptAuth={vi.fn()}
      />,
    );

    await waitFor(() => expect(submitBtn()).not.toBeDisabled());

    const titleInput = document.getElementById('listing-title-input') as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(titleInput);
    await user.type(titleInput, 'My unsaved edit');

    rerender(
      <CreateListingModal
        isOpen={true}
        user={seller}
        mode="edit"
        initialAuction={other}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onUpdated={vi.fn()}
        onPromptAuth={vi.fn()}
      />,
    );

    await waitFor(() => expect(titleInput.value).toBe('A Different Listing'));
  });
});

describe('CreateListingModal (image upload)', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedCompressImageToBlob.mockReset();
    // Tags the compressed blob's content with the source file's name, so a mocked
    // `uploadImage` further down the chain can key its behaviour off *which* file this is
    // without depending on the order concurrent uploads happen to settle in.
    mockedCompressImageToBlob.mockImplementation(
      async (file: File) => new Blob([`compressed:${file.name}`], { type: file.type || 'image/jpeg' }),
    );
    mockedUploadImage.mockReset();
    mockedUploadImage.mockImplementation(
      async () => ({ url: '/images/img_default', key: 'img_default' }),
    );
  });

  it('uploads a picked image on selection and submits the returned /images/<key> path, not base64', async () => {
    mockedUploadImage.mockResolvedValueOnce({ url: '/images/img_abc123', key: 'img_abc123' });
    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/auctions' && init?.method === 'POST') {
        const body = JSON.parse(init!.body as string);
        return { ok: true, status: 201, json: async () => ({ auction: { ...makeFullAuction(), ...body } }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    const { onCreated } = renderCreateModal();
    const user = userEvent.setup();
    await fillRequiredNonImageFields(user);

    await user.upload(imagesInput(), makeImageFile());

    // The upload resolves and the thumbnail leaves its uploading state.
    await waitFor(() => expect(submitBtn()).not.toBeDisabled());
    expect(mockedCompressImageToBlob).toHaveBeenCalledTimes(1);
    expect(mockedUploadImage).toHaveBeenCalledTimes(1);

    await user.click(submitBtn());

    await waitFor(() => {
      const postCall = mockedApiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(postCall).toBeTruthy();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.imageUrls).toEqual(['/images/img_abc123']);
      expect(body.imageUrl).toBe('/images/img_abc123');
      // The whole point of the migration: no base64 data URL ever leaves the client.
      expect(body.imageUrls.some((url: string) => url.startsWith('data:'))).toBe(false);
    });

    expect(onCreated).toHaveBeenCalled();
  });

  it('disables submit while an upload is in flight, and re-enables once it resolves', async () => {
    let resolveUpload: (value: { url: string; key: string }) => void = () => {};
    mockedUploadImage.mockImplementationOnce(
      () => new Promise((resolve) => { resolveUpload = resolve; }),
    );

    renderCreateModal();
    const user = userEvent.setup();
    await fillRequiredNonImageFields(user);

    await user.upload(imagesInput(), makeImageFile());

    expect(submitBtn()).toBeDisabled();
    expect(submitBtn()).toHaveTextContent('Uploading...');
    expect(screen.getByText(/Uploading image, please wait/i)).toBeInTheDocument();

    resolveUpload({ url: '/images/img_ready', key: 'img_ready' });

    await waitFor(() => expect(submitBtn()).not.toBeDisabled());
  });

  it('shows a failed upload per-image and lets the other images survive, with a working retry', async () => {
    // Keyed off the compressed blob's tagged content (see the compressImageToBlob mock above)
    // rather than call order, since the two files' uploads race each other after selection.
    const attemptsByFile: Record<string, number> = {};
    mockedUploadImage.mockImplementation(async (blob: Blob) => {
      const name = (await blob.text()).replace('compressed:', '');
      attemptsByFile[name] = (attemptsByFile[name] ?? 0) + 1;

      if (name === 'bad.jpg' && attemptsByFile[name] === 1) {
        throw new Error('Network error while uploading.');
      }
      if (name === 'bad.jpg') {
        return { url: '/images/img_retry_ok', key: 'img_retry_ok' };
      }
      return { url: '/images/img_second', key: 'img_second' };
    });

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/auctions' && init?.method === 'POST') {
        const body = JSON.parse(init!.body as string);
        return { ok: true, status: 201, json: async () => ({ auction: { ...makeFullAuction(), ...body } }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    renderCreateModal();
    const user = userEvent.setup();
    await fillRequiredNonImageFields(user);

    // The second image ("good.jpg") succeeds on its first attempt; this confirms it survives
    // the first image's failure and retry untouched.
    await user.upload(imagesInput(), [makeImageFile('bad.jpg'), makeImageFile('good.jpg')]);

    const failureMessage = await screen.findByText(/Image 1: Network error while uploading\./i);
    expect(failureMessage).toBeInTheDocument();

    // Submitting with a failed image present is refused with a specific, actionable message
    // rather than silently dropping the broken image.
    await user.click(submitBtn());
    expect(
      await screen.findByText(/One or more images failed to upload\. Please retry or remove them/i),
    ).toBeInTheDocument();
    expect(mockedApiFetch).not.toHaveBeenCalled();

    const retryBtn = screen.getByRole('button', { name: /Retry uploading image 1/i });
    await user.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByText(/Image 1: Network error while uploading\./i)).not.toBeInTheDocument();
    });
    await waitFor(() => expect(submitBtn()).not.toBeDisabled());

    await user.click(submitBtn());

    await waitFor(() => {
      const postCall = mockedApiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(postCall).toBeTruthy();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      // Both images made it through: the survivor from before the failure, and the retried one.
      expect(body.imageUrls).toEqual(expect.arrayContaining(['/images/img_second', '/images/img_retry_ok']));
      expect(body.imageUrls).toHaveLength(2);
    });
  });

  it('maps UNSUPPORTED_IMAGE_TYPE and IMAGE_TOO_LARGE to specific, human messages', async () => {
    mockedUploadImage
      .mockRejectedValueOnce(
        new ImageUploadError('This file type is not supported. Please upload a JPEG, PNG, WEBP, or GIF image.', 'UNSUPPORTED_IMAGE_TYPE'),
      )
      .mockRejectedValueOnce(
        new ImageUploadError('This image is over the 5 MB limit. Please choose a smaller file.', 'IMAGE_TOO_LARGE'),
      );

    renderCreateModal();
    // The real check that rejects a `.bmp` happens server-side (`POST /api/images` -- mocked
    // here via `uploadImage`); `applyAccept: false` stops user-event's own client-side filtering
    // by the file input's `accept` attribute from silently dropping the file before it gets there.
    const user = userEvent.setup({ applyAccept: false });
    await fillRequiredNonImageFields(user);

    await user.upload(imagesInput(), makeImageFile('weird.bmp', 'image/bmp'));
    expect(await screen.findByText(/Image 1:.*not supported.*JPEG, PNG, WEBP, or GIF/i)).toBeInTheDocument();

    await user.upload(imagesInput(), makeImageFile('huge.jpg'));
    expect(await screen.findByText(/Image 2:.*over the 5 MB limit/i)).toBeInTheDocument();
  });

  it('edit mode: does not re-upload an already-stored image, only the newly added file', async () => {
    const full = makeFullAuction({
      imageUrls: ['https://example.test/camera-1.jpg', '/images/img_existing'],
    });
    mockedUploadImage.mockResolvedValueOnce({ url: '/images/img_new', key: 'img_new' });

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/auctions/${full.id}` && init?.method === 'PATCH') {
        const body = JSON.parse(init!.body as string);
        return { ok: true, status: 200, json: async () => ({ auction: { ...full, ...body } }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    renderEditModal(full);
    const user = userEvent.setup();

    await waitFor(() => expect(submitBtn()).not.toBeDisabled());

    await user.upload(imagesInput(), makeImageFile('added.jpg'));
    await waitFor(() => expect(mockedUploadImage).toHaveBeenCalledTimes(1));

    await user.click(submitBtn());

    await waitFor(() => {
      const patchCall = mockedApiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body.imageUrls).toEqual([
        'https://example.test/camera-1.jpg',
        '/images/img_existing',
        '/images/img_new',
      ]);
    });

    // The two pre-existing images (one a plain https URL, one already an R2 path) were never
    // handed to uploadImage -- only the one freshly-picked file was.
    expect(mockedUploadImage).toHaveBeenCalledTimes(1);
  });
});

describe('CreateListingModal (IMAGE_STORAGE_UNAVAILABLE fallback)', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedCompressImageToBlob.mockReset();
    mockedCompressImageToBlob.mockImplementation(
      async (file: File) => new Blob([`compressed:${file.name}`], { type: file.type || 'image/jpeg' }),
    );
    mockedUploadImage.mockReset();
  });

  it('falls back to a base64 data: URL when upload answers IMAGE_STORAGE_UNAVAILABLE, and submits successfully', async () => {
    mockedUploadImage.mockRejectedValueOnce(
      new ImageUploadError('Image storage is not currently available.', 'IMAGE_STORAGE_UNAVAILABLE'),
    );
    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/auctions' && init?.method === 'POST') {
        const body = JSON.parse(init!.body as string);
        return { ok: true, status: 201, json: async () => ({ auction: { ...makeFullAuction(), ...body } }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    const { onCreated } = renderCreateModal();
    const user = userEvent.setup();
    await fillRequiredNonImageFields(user);

    await user.upload(imagesInput(), makeImageFile());

    // No warning/degraded-mode banner -- the fallback is invisible on success -- and the upload
    // "failure" resolves the slot exactly like a success would: submit re-enables, no per-image
    // error is shown.
    await waitFor(() => expect(submitBtn()).not.toBeDisabled());
    expect(screen.queryByText(/Image 1:/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not currently available/i)).not.toBeInTheDocument();

    await user.click(submitBtn());

    await waitFor(() => {
      const postCall = mockedApiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(postCall).toBeTruthy();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.imageUrls).toHaveLength(1);
      expect(body.imageUrls[0]).toMatch(/^data:/);
      expect(body.imageUrl).toBe(body.imageUrls[0]);
    });

    expect(onCreated).toHaveBeenCalled();
  });

  it('does not re-attempt an upload for a second image after the first one hits IMAGE_STORAGE_UNAVAILABLE', async () => {
    mockedUploadImage.mockRejectedValueOnce(
      new ImageUploadError('Image storage is not currently available.', 'IMAGE_STORAGE_UNAVAILABLE'),
    );

    renderCreateModal();
    const user = userEvent.setup();
    await fillRequiredNonImageFields(user);

    await user.upload(imagesInput(), makeImageFile('first.jpg'));
    await waitFor(() => expect(submitBtn()).not.toBeDisabled());
    expect(mockedUploadImage).toHaveBeenCalledTimes(1);

    await user.upload(imagesInput(), makeImageFile('second.jpg'));
    await waitFor(() => expect(submitBtn()).not.toBeDisabled());

    // The second image resolved via the base64 fallback without ever calling uploadImage again.
    expect(mockedUploadImage).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Image 2:/i)).not.toBeInTheDocument();
  });

  it('does not fall back to base64 on UNSUPPORTED_IMAGE_TYPE, IMAGE_TOO_LARGE, or a plain network error', async () => {
    mockedUploadImage
      .mockRejectedValueOnce(new ImageUploadError('Not supported.', 'UNSUPPORTED_IMAGE_TYPE'))
      .mockRejectedValueOnce(new ImageUploadError('Too large.', 'IMAGE_TOO_LARGE'))
      .mockRejectedValueOnce(new Error('Network error while uploading.'));

    renderCreateModal();
    const user = userEvent.setup({ applyAccept: false });
    await fillRequiredNonImageFields(user);

    await user.upload(imagesInput(), makeImageFile('one.jpg'));
    expect(await screen.findByText(/Image 1:.*Not supported\./i)).toBeInTheDocument();

    await user.upload(imagesInput(), makeImageFile('two.jpg'));
    expect(await screen.findByText(/Image 2:.*Too large\./i)).toBeInTheDocument();

    await user.upload(imagesInput(), makeImageFile('three.jpg'));
    expect(await screen.findByText(/Image 3:.*Network error while uploading\./i)).toBeInTheDocument();

    // None of these real failures were converted into a base64 fallback: each slot stayed in its
    // own error state, submit is refused, and the flag that would skip future uploads was never set.
    await user.click(submitBtn());
    expect(
      await screen.findByText(/One or more images failed to upload\. Please retry or remove them/i),
    ).toBeInTheDocument();
    expect(mockedApiFetch).not.toHaveBeenCalled();

    mockedUploadImage.mockResolvedValueOnce({ url: '/images/img_after_errors', key: 'img_after_errors' });
    const retryBtn = screen.getByRole('button', { name: /Retry uploading image 3/i });
    await user.click(retryBtn);
    await waitFor(() => expect(mockedUploadImage).toHaveBeenCalledTimes(4));
  });

  it('successful upload still submits the /images/<key> path unchanged when storage is available', async () => {
    mockedUploadImage.mockResolvedValueOnce({ url: '/images/img_normal', key: 'img_normal' });
    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/auctions' && init?.method === 'POST') {
        const body = JSON.parse(init!.body as string);
        return { ok: true, status: 201, json: async () => ({ auction: { ...makeFullAuction(), ...body } }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    renderCreateModal();
    const user = userEvent.setup();
    await fillRequiredNonImageFields(user);
    await user.upload(imagesInput(), makeImageFile());
    await waitFor(() => expect(submitBtn()).not.toBeDisabled());

    await user.click(submitBtn());

    await waitFor(() => {
      const postCall = mockedApiFetch.mock.calls.find(([, init]) => init?.method === 'POST');
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.imageUrls).toEqual(['/images/img_normal']);
    });
  });

  it('edit mode: falls back for a newly added image without touching already-stored ones', async () => {
    const full = makeFullAuction({
      imageUrls: ['https://example.test/camera-1.jpg', '/images/img_existing'],
    });
    mockedUploadImage.mockRejectedValueOnce(
      new ImageUploadError('Image storage is not currently available.', 'IMAGE_STORAGE_UNAVAILABLE'),
    );

    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/auctions/${full.id}` && init?.method === 'PATCH') {
        const body = JSON.parse(init!.body as string);
        return { ok: true, status: 200, json: async () => ({ auction: { ...full, ...body } }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    renderEditModal(full);
    const user = userEvent.setup();
    await waitFor(() => expect(submitBtn()).not.toBeDisabled());

    await user.upload(imagesInput(), makeImageFile('added.jpg'));
    await waitFor(() => expect(submitBtn()).not.toBeDisabled());
    expect(mockedUploadImage).toHaveBeenCalledTimes(1);

    await user.click(submitBtn());

    await waitFor(() => {
      const patchCall = mockedApiFetch.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeTruthy();
      const body = JSON.parse((patchCall![1] as RequestInit).body as string);
      expect(body.imageUrls).toHaveLength(3);
      expect(body.imageUrls[0]).toBe('https://example.test/camera-1.jpg');
      expect(body.imageUrls[1]).toBe('/images/img_existing');
      expect(body.imageUrls[2]).toMatch(/^data:/);
    });

    // Still only the one freshly-picked file ever reached uploadImage -- the two stored images
    // were never re-uploaded, whether storage is available or not.
    expect(mockedUploadImage).toHaveBeenCalledTimes(1);
  });
});

describe('CreateListingModal (price and field limits)', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedCompressImageToBlob.mockReset();
    mockedCompressImageToBlob.mockImplementation(
      async (file: File) => new Blob([`compressed:${file.name}`], { type: file.type || 'image/jpeg' }),
    );
    mockedUploadImage.mockReset();
    mockedUploadImage.mockImplementation(async () => ({ url: '/images/img_price', key: 'img_price' }));
  });

  // Dispatching `submit` directly exercises the app's own validation: a real click would be
  // stopped first by the browser's constraint validation on the input's min/max/step.
  function submitForm() {
    fireEvent.submit(submitBtn().closest('form') as HTMLFormElement);
  }

  it('has a single Price field (no starting price or duration) mirroring the server limits', () => {
    renderCreateModal();

    const input = priceInput();
    expect(input).toBeInTheDocument();
    expect(input.getAttribute('step')).toBe('0.01');
    expect(input.getAttribute('min')).toBe('0.01');
    expect(input.getAttribute('max')).toBe('100000');
    expect(document.getElementById('listing-starting-price-input')).toBeNull();
    expect(document.getElementById('listing-custom-duration-input')).toBeNull();
    expect(screen.queryByText(/duration/i)).toBeNull();
  });

  it('caps title, description and phone at the server limits', () => {
    renderCreateModal();

    expect(document.getElementById('listing-title-input')).toHaveAttribute('maxLength', '100');
    expect(document.getElementById('listing-description-input')).toHaveAttribute('maxLength', '2000');
    expect(document.getElementById('listing-phone-input')).toHaveAttribute('maxLength', '30');
  });

  it('tells a new seller that listings expire after 30 days', () => {
    renderCreateModal();
    expect(document.getElementById('listing-lifetime-note')).toHaveTextContent(/expire 30 days after/i);
  });

  it.each([
    ['0', /greater than £0/i],
    ['-3', /greater than £0/i],
    ['100000.01', /more than £100,000/i],
    ['12.345', /two decimal places/i],
  ])('refuses a price of %s with a friendly message and sends nothing', async (value, message) => {
    renderCreateModal();
    const user = userEvent.setup();
    await fillRequiredNonImageFields(user);
    await user.clear(priceInput());
    await user.type(priceInput(), value);

    submitForm();

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it('POSTs `price` in pounds -- and no startingPrice or durationMinutes', async () => {
    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/auctions' && init?.method === 'POST') {
        const body = JSON.parse(init!.body as string);
        return { ok: true, status: 201, json: async () => ({ auction: { ...makeFullAuction(), ...body } }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    const { onCreated } = renderCreateModal();
    const user = userEvent.setup();
    await fillRequiredNonImageFields(user);
    await user.clear(priceInput());
    await user.type(priceInput(), '12.50');
    await user.upload(imagesInput(), makeImageFile());
    await waitFor(() => expect(submitBtn()).not.toBeDisabled());

    await user.click(submitBtn());

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const [, init] = mockedApiFetch.mock.calls.find(([url]) => url === '/api/auctions')!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.price).toBe(12.5);
    expect(body).not.toHaveProperty('startingPrice');
    expect(body).not.toHaveProperty('durationMinutes');
  });

  it('edit mode: prefills the current price and PATCHes the new one', async () => {
    const full = makeFullAuction({ price: 40 });
    mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/auctions/${full.id}` && init?.method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ auction: { ...full, price: 35 } }) } as Response;
      }
      throw new Error(`Unexpected apiFetch call: ${url} ${init?.method ?? 'GET'}`);
    });

    const { onUpdated } = renderEditModal(full);
    await waitFor(() => expect(priceInput().value).toBe('40'));

    const user = userEvent.setup();
    await user.clear(priceInput());
    await user.type(priceInput(), '35');
    await user.click(submitBtn());

    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ price: 35 })));
    const [, init] = mockedApiFetch.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'PATCH')!;
    expect(JSON.parse((init as RequestInit).body as string).price).toBe(35);
  });
});
