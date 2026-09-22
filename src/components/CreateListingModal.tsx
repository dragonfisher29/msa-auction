import React, { useEffect, useRef, useState } from 'react';
import { X, Tag, Phone, PoundSterling, Clock, FileText, AlertCircle, Trash2, Upload, ChevronDown, PencilLine, RefreshCw, RotateCcw } from 'lucide-react';
import { apiFetch, apiFetchAuthed } from '../lib/api';
import { SELECTABLE_CATEGORIES } from '../lib/categories';
import { User, AuctionItem } from '../types';
import {
  AUTH_ERROR_CODES,
  IMAGE_STORAGE_UNAVAILABLE,
  LISTING_HAS_BIDS,
  LISTING_NOT_EDITABLE,
  NOT_LISTING_OWNER,
  readErrorCode,
  stripErrorCode,
} from '../lib/apiErrors';
import {
  ACCEPTED_IMAGE_TYPES_LABEL,
  blobToDataUrl,
  compressImageToBlob,
  createPreviewUrl,
  fetchAuctionImages,
  ImageUploadError,
  revokePreviewUrl,
  uploadImage,
} from '../lib/images';

interface CreateListingModalProps {
  isOpen: boolean;
  user: User | null;
  onClose: () => void;
  onCreated: (auction: AuctionItem) => void;
  onPromptAuth: () => void;
  /** Defaults to 'create'. 'edit' reuses this whole form to PATCH an existing listing instead of
   *  creating a new one -- see the API contract: PATCH is seller-only and only while the listing
   *  has zero bids, and it does not accept a duration (an auction's schedule cannot be edited). */
  mode?: 'create' | 'edit';
  /** Required when `mode` is 'edit': the listing being edited, used to prefill the form.
   *  When it lacks `imageUrls` (e.g. a row from `GET /api/users/me/activity`, which ships only
   *  `imageCount` -- see that field's doc comment on `AuctionItem`), the modal treats it as a
   *  partial record: it prefills the text fields from it immediately, then re-fetches
   *  `GET /api/auctions/:id` for the real images before the form can be submitted. */
  initialAuction?: AuctionItem | null;
  /** Required when `mode` is 'edit': called with the server's updated auction on a successful PATCH. */
  onUpdated?: (auction: AuctionItem) => void;
}

const PRESET_DURATIONS = [
  { label: '2 Mins (Fast Test)', minutes: 2 },
  { label: '5 Mins', minutes: 5 },
  { label: '6 Hours', minutes: 360 },
  { label: '24 Hours', minutes: 1440 },
  { label: '3 Days', minutes: 4320 },
  { label: '7 Days', minutes: 10080 },
];

const MAX_IMAGES = 3;

type ImageSlotStatus = 'stored' | 'uploading' | 'ready' | 'error';

/**
 * One image thumbnail in the form. `stored` covers anything that already has a final value on
 * the server -- a legacy `data:` URL, an `/images/<key>` path, or (in tests/fixtures) a plain
 * http(s) URL -- and is never re-uploaded. `uploading`/`ready`/`error` track a freshly picked
 * file through client-side compression and `POST /api/images`; only `ready` (and `stored`)
 * slots contribute a value to the submitted `imageUrls`.
 */
interface ImageSlot {
  id: string;
  status: ImageSlotStatus;
  /** What `<img src>` renders: the stored value/URL, or a local blob preview while uploading. */
  previewSrc: string;
  /** The value to submit once resolved -- null while uploading or failed. */
  value: string | null;
  error: string | null;
  /** The originally picked file, kept only so a failed upload can be retried without asking the
   *  user to re-select it. Always null for `stored` slots. */
  file: File | null;
}

let imageSlotSeq = 0;
const nextSlotId = () => `img-slot-${++imageSlotSeq}`;

const slotsFromStoredValues = (values: string[]): ImageSlot[] =>
  values
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => ({
      id: nextSlotId(),
      status: 'stored' as const,
      previewSrc: value,
      value,
      error: null,
      file: null,
    }));

export const CreateListingModal: React.FC<CreateListingModalProps> = ({
  isOpen,
  user,
  onClose,
  onCreated,
  onPromptAuth,
  mode = 'create',
  initialAuction = null,
  onUpdated,
}) => {
  const isEditMode = mode === 'edit';

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [startingPrice, setStartingPrice] = useState<string>('150');
  const [durationMinutes, setDurationMinutes] = useState<number>(5);
  const [customDuration, setCustomDuration] = useState<string>('');
  const [category, setCategory] = useState('Electronics');
  const [imageSlots, setImageSlots] = useState<ImageSlot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Edit mode only: true while re-fetching the full listing (see the effect below). Gates the
  // submit button so a half-populated form -- e.g. `initialAuction` with no real images yet --
  // can never be saved.
  const [isLoadingListing, setIsLoadingListing] = useState(false);
  // Set instead of the general `error` above so it can't be cleared by an unrelated action (e.g.
  // picking an image resets `error`) and survives until the dialog is closed and reopened.
  const [loadListingError, setLoadListingError] = useState<string | null>(null);

  // Set the first time `POST /api/images` answers `IMAGE_STORAGE_UNAVAILABLE` (R2 not configured
  // in this environment -- expected at this deploy). Once true, every subsequent image in this
  // modal session skips the upload attempt entirely and goes straight to the base64 `data:` URL
  // fallback, rather than re-discovering the same 503 on every image. A ref, not state: flipping
  // it must never itself trigger a re-render, and it's reset below whenever the modal is (re)opened.
  const storageUnavailableRef = useRef(false);

  // Mirrors `imageSlots` so the unmount cleanup effect below can revoke blob preview URLs
  // without depending on (and re-subscribing to) `imageSlots` itself.
  const imageSlotsRef = useRef<ImageSlot[]>([]);
  useEffect(() => {
    imageSlotsRef.current = imageSlots;
  }, [imageSlots]);

  // Blob preview URLs are only ever created client-side for freshly picked files (see
  // `handleImageSelection`); release whatever's left when the modal instance goes away so a long
  // session of opening/closing this dialog doesn't leak object URLs.
  useEffect(() => {
    return () => {
      imageSlotsRef.current.forEach((slot) => revokePreviewUrl(slot.previewSrc));
    };
  }, []);

  const resetForm = () => {
    if (isEditMode && initialAuction) {
      setTitle(initialAuction.title);
      setDescription(initialAuction.description);
      setPhoneNumber(initialAuction.phoneNumber ?? '');
      setStartingPrice(String(initialAuction.startingPrice));
      setDurationMinutes(5);
      setCustomDuration('');
      setCategory(initialAuction.category || 'Electronics');
      setImageSlots(
        slotsFromStoredValues(
          Array.isArray(initialAuction.imageUrls) && initialAuction.imageUrls.length > 0
            ? initialAuction.imageUrls
            : initialAuction.imageUrl
            ? [initialAuction.imageUrl]
            : [],
        ),
      );
      setError(null);
      setIsSubmitting(false);
      return;
    }

    setTitle('');
    setDescription('');
    setPhoneNumber('');
    setStartingPrice('150');
    setDurationMinutes(5);
    setCustomDuration('');
    setCategory('Electronics');
    setImageSlots([]);
    setError(null);
    setIsSubmitting(false);
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // Instant first paint from whatever was passed in -- including, in the partial-row case
    // below, the text fields, which the activity feed's summary row DOES carry accurately.
    resetForm();
    setLoadListingError(null);
    storageUnavailableRef.current = false;

    if (!isEditMode || !initialAuction) {
      setIsLoadingListing(false);
      return;
    }

    // `imageUrls` is only ever present on a full row (see the doc comment on `imageCount` in
    // `AuctionItem`); AuctionDetailModal's `auction` is one (it comes from, and is kept fresh by
    // polling, `GET /api/auctions/:id`), so there is nothing to fetch and no need to touch the
    // network again.
    if (Array.isArray(initialAuction.imageUrls)) {
      setIsLoadingListing(false);
      return;
    }

    // Partial row -- e.g. AccountView's "My Listings", sourced from `/api/users/me/activity`,
    // which ships `imageCount` instead of real image data. Re-fetch the full listing before the
    // form can be trusted: submitting on the partial row's empty image list would PATCH
    // `imageUrls: []` and get rejected as MISSING_IMAGES.
    let cancelled = false;
    setIsLoadingListing(true);

    (async () => {
      try {
        // Authed with the seller's own token: GET /api/auctions/:id only sends phoneNumber back
        // for a signed-in caller (see mapAuctionDetailRow), and this is only ever reached with
        // the seller themselves signed in (edit mode is seller-only).
        const res = await apiFetchAuthed(`/api/auctions/${initialAuction.id}`, user?.token);
        const data = await res.json().catch(() => null);

        if (cancelled) return;

        if (!res.ok || !data?.auction) {
          setLoadListingError('Could not load the current listing details. Please close this dialog and try again.');
          return;
        }

        const fresh = data.auction as AuctionItem;
        // Overwrite everything, including the fields `resetForm` already painted from the
        // partial row above, so nothing stale from `initialAuction` can reach the PATCH body.
        setTitle(fresh.title);
        setDescription(fresh.description);
        setPhoneNumber(fresh.phoneNumber ?? '');
        setStartingPrice(String(fresh.startingPrice));
        setCategory(fresh.category || 'Electronics');

        // The detail endpoint no longer ships imageUrls/imageUrl at all (see
        // mapAuctionDetailRow) -- fall back to the same cached images route AuctionCard and
        // AuctionDetailModal use. Still checked first in case a caller ever hands over a row
        // that does carry them inline.
        const imageUrls =
          Array.isArray(fresh.imageUrls) && fresh.imageUrls.length > 0
            ? fresh.imageUrls
            : fresh.imageUrl
            ? [fresh.imageUrl]
            : await fetchAuctionImages(fresh.id);

        if (cancelled) return;
        setImageSlots(slotsFromStoredValues(imageUrls));
      } catch (err) {
        if (!cancelled) {
          setLoadListingError('Network error while loading the current listing details. Please close this dialog and try again.');
        }
      } finally {
        if (!cancelled) {
          setIsLoadingListing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Depend on the listing's id, not the `initialAuction` object reference: AuctionDetailModal
    // passes its polled `auction`, which gets a new object identity every ~3s even when nothing
    // the user cares about has changed. Keying off identity would re-run this effect (and its
    // `resetForm()`) on every poll tick, wiping out whatever the user has typed. Keying off `id`
    // means it only re-runs when the modal opens or is genuinely pointed at a different listing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isEditMode, initialAuction?.id]);

  if (!isOpen) return null;

  // Resolves one already-compressed blob straight to a base64 `data:` URL and writes it into the
  // matching slot as if it had uploaded -- the `IMAGE_STORAGE_UNAVAILABLE` fallback. Deliberately
  // indistinguishable from a successful upload to the rest of the form: no banner, no separate
  // status, because there is nothing the user can do about it and the listing works either way.
  const resolveSlotWithDataUrl = async (slotId: string, blob: Blob) => {
    const dataUrl = await blobToDataUrl(blob);
    setImageSlots((current) =>
      current.map((slot) => (slot.id === slotId ? { ...slot, status: 'ready', value: dataUrl, error: null } : slot)),
    );
  };

  // Compresses then uploads one freshly-picked file, writing the result back into the slot with
  // a matching `id`. Never throws -- a failure lands in that slot's own `error`, so one bad file
  // can never take out the others or the form as a whole.
  //
  // When object storage isn't configured server-side, `uploadImage` fails every single time with
  // `IMAGE_STORAGE_UNAVAILABLE` -- there is no transient recovery to wait for -- so the first such
  // response flips `storageUnavailableRef` and every subsequent call here (including this modal's
  // remaining in-flight selections and any later ones) skips straight to the base64 fallback
  // instead of re-discovering the same 503 on every image.
  const processImageSlot = async (slotId: string, file: File, token: string | null | undefined) => {
    try {
      const blob = await compressImageToBlob(file);

      if (storageUnavailableRef.current) {
        await resolveSlotWithDataUrl(slotId, blob);
        return;
      }

      try {
        const { url } = await uploadImage(blob, token);
        setImageSlots((current) =>
          current.map((slot) => (slot.id === slotId ? { ...slot, status: 'ready', value: url, error: null } : slot)),
        );
      } catch (uploadErr) {
        if (uploadErr instanceof ImageUploadError && uploadErr.code === IMAGE_STORAGE_UNAVAILABLE) {
          storageUnavailableRef.current = true;
          await resolveSlotWithDataUrl(slotId, blob);
          return;
        }
        // Any other failure -- unsupported type, too large, auth, a genuine network error -- is a
        // real failure and must surface as one, never be swallowed into the base64 fallback.
        throw uploadErr;
      }
    } catch (err) {
      const message =
        err instanceof ImageUploadError || err instanceof Error
          ? err.message
          : 'Unable to upload this image.';
      setImageSlots((current) =>
        current.map((slot) => (slot.id === slotId ? { ...slot, status: 'error', value: null, error: message } : slot)),
      );
    }
  };

  const handleImageSelection = (evt: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(evt.target.files ?? []).filter((entry): entry is File => entry instanceof File);
    evt.target.value = '';

    if (files.length === 0) {
      return;
    }

    // The listing's real images may still be in flight (see the effect above); anything picked
    // now would just be overwritten the moment that fetch resolves.
    if (isEditMode && isLoadingListing) {
      return;
    }

    // Uploading requires a bearer token; the "Sign in required" banner covers the rest of the
    // form, but the file picker itself has no other guard against a signed-out visitor.
    if (!user) {
      setError('Please sign in to upload images.');
      return;
    }

    const remainingSlots = MAX_IMAGES - imageSlots.length;
    if (files.length > remainingSlots) {
      setError(`You can upload up to ${MAX_IMAGES} images total. Please choose ${remainingSlots} or fewer file(s).`);
      return;
    }

    setError(null);

    const token = user.token;
    const newSlots: ImageSlot[] = files.map((file) => ({
      id: nextSlotId(),
      status: 'uploading',
      previewSrc: createPreviewUrl(file),
      value: null,
      error: null,
      file,
    }));

    setImageSlots((current) => [...current, ...newSlots]);

    newSlots.forEach((slot) => {
      void processImageSlot(slot.id, slot.file as File, token);
    });
  };

  const retryImageSlot = (id: string) => {
    const slot = imageSlots.find((s) => s.id === id);
    if (!slot || !slot.file || !user) {
      return;
    }
    setImageSlots((current) =>
      current.map((s) => (s.id === id ? { ...s, status: 'uploading', error: null } : s)),
    );
    void processImageSlot(id, slot.file, user.token);
  };

  const removeImage = (id: string) => {
    if (isEditMode && isLoadingListing) {
      return;
    }
    setImageSlots((current) => {
      const slot = current.find((s) => s.id === id);
      if (slot) {
        revokePreviewUrl(slot.previewSrc);
      }
      return current.filter((s) => s.id !== id);
    });
    setError(null);
  };

  const hasUploadInProgress = imageSlots.some((slot) => slot.status === 'uploading');
  const hasFailedUpload = imageSlots.some((slot) => slot.status === 'error');
  const resolvedImageValues = imageSlots
    .map((slot) => slot.value)
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!user) {
      onPromptAuth();
      return;
    }

    // Belt-and-braces alongside the disabled submit button below: never let a PATCH out while
    // the real record is still loading, or after it failed to load.
    if (isEditMode && (isLoadingListing || loadListingError)) {
      return;
    }

    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    const trimmedPhoneNumber = phoneNumber.trim();

    if (!trimmedTitle || !trimmedDescription || !trimmedPhoneNumber) {
      setError('Please complete the title, description, and phone number fields.');
      return;
    }

    // The WhatsApp contact link is built straight from this value, so it has to be a full
    // international number. A single leading 0 is a local trunk prefix and means the country
    // code is missing; a leading 00 is the ITU international prefix, so it is fine.
    const phoneDigits = trimmedPhoneNumber.replace(/\D/g, '');
    if (phoneDigits.length < 8 || phoneDigits.length > 15 || /^0(?!0)/.test(trimmedPhoneNumber)) {
      setError('Please enter your full phone number including the country code, for example +44 7700 900123.');
      return;
    }

    if (imageSlots.length === 0) {
      setError('Please upload at least one image before publishing the listing.');
      return;
    }

    if (hasUploadInProgress) {
      // Belt-and-braces alongside the disabled submit button below.
      return;
    }

    if (hasFailedUpload) {
      setError('One or more images failed to upload. Please retry or remove them before publishing.');
      return;
    }

    if (resolvedImageValues.length === 0) {
      setError('Please upload at least one image before publishing the listing.');
      return;
    }

    const priceNum = Number(startingPrice);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      setError('Starting price must be greater than £0.');
      return;
    }

    // The duration field doesn't exist in edit mode at all (a listing's schedule can't be
    // changed once published), so this validation -- and sending it in the request body below --
    // only applies to creating a new listing.
    let finalDuration = 0;
    if (!isEditMode) {
      finalDuration = customDuration ? parseInt(customDuration, 10) : durationMinutes;
      if (!Number.isInteger(finalDuration) || finalDuration <= 0) {
        setError('Duration must be at least 1 minute.');
        return;
      }
    }

    setIsSubmitting(true);

    try {
      if (isEditMode) {
        if (!initialAuction) {
          throw new Error('Nothing to save: no listing was provided to edit.');
        }

        const res = await apiFetchAuthed(`/api/auctions/${initialAuction.id}`, user.token, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: trimmedTitle,
            description: trimmedDescription,
            phoneNumber: trimmedPhoneNumber,
            category: category.trim() || 'General',
            imageUrls: resolvedImageValues,
            startingPrice: priceNum,
          }),
        });

        const data = await res.json().catch(() => null);

        if (!res.ok) {
          const code = readErrorCode(data);

          if (code && AUTH_ERROR_CODES.has(code)) {
            setError('Your session has expired. Please sign in again to save these changes.');
            return;
          }
          if (code === LISTING_HAS_BIDS) {
            setError('This listing already has bids and can no longer be edited. You can cancel it instead.');
            return;
          }
          if (code === NOT_LISTING_OWNER) {
            setError('You are not the seller of this listing, so it cannot be edited from here.');
            return;
          }
          if (code === LISTING_NOT_EDITABLE) {
            setError('This listing is no longer editable (it may have ended or already been cancelled).');
            return;
          }

          setError(data?.error ? stripErrorCode(data.error) : `Request failed with status ${res.status}.`);
          return;
        }

        onUpdated?.(data.auction);
        onClose();
        return;
      }

      const res = await apiFetchAuthed('/api/auctions', user.token, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: trimmedTitle,
          description: trimmedDescription,
          phoneNumber: trimmedPhoneNumber,
          startingPrice: priceNum,
          durationMinutes: finalDuration,
          sellerId: user.id,
          sellerName: user.name,
          imageUrls: resolvedImageValues,
          imageUrl: resolvedImageValues[0],
          category: category.trim() || 'General',
        }),
      });

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (!res.ok) {
        throw new Error(data?.error || `Request failed with status ${res.status}.`);
      }

      onCreated(data.auction);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : `An error occurred while ${isEditMode ? 'saving' : 'creating'} the listing.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-[#1e293b]/40 backdrop-blur-xs overflow-y-auto">
      {/* Bounded shell + its own scroll body: the header (and its close button) stays put
          while the long form scrolls beneath it. */}
      <div className="relative w-full max-w-xl bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl shadow-xl overflow-hidden text-[#1e293b] my-2 sm:my-8 flex flex-col modal-max-h">
        <div className="flex items-center justify-between gap-2 px-4 sm:px-6 py-3 sm:py-4 border-b border-[#ccdbfd] bg-[#d7e3fc] shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 shrink-0 rounded-lg bg-[#b6ccfe] flex items-center justify-center text-[#1e293b]">
              {isEditMode ? <PencilLine className="w-4 h-4" /> : <Tag className="w-4 h-4" />}
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-lg font-bold text-[#1e293b] leading-tight">
                {isEditMode ? 'Edit Listing' : 'Create New Auction Listing'}
              </h2>
              <p className="text-xs text-[#1e293b]/70 hidden sm:block">
                {isEditMode ? 'Update the details buyers see before any bids come in' : 'Publish an item for real-time live bidding'}
              </p>
            </div>
          </div>
          <button
            id="close-create-modal-btn"
            onClick={onClose}
            aria-label="Close create listing form"
            className="shrink-0 inline-flex items-center justify-center p-2 min-h-[44px] min-w-[44px] rounded-lg text-[#1e293b]/70 hover:text-[#1e293b] hover:bg-[#c1d3fe] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain">
        {!user && (
          <div className="m-4 sm:m-6 p-4 rounded-xl bg-[#d7e3fc] border border-[#ccdbfd] flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-[#1e293b] shrink-0 mt-0.5" />
            <div className="text-xs">
              <p className="font-bold text-[#1e293b]">Sign in required to create listings</p>
              <p className="text-[#1e293b]/80 mt-0.5">
                You must be signed in with a username to host an auction.
              </p>
              <button
                type="button"
                onClick={onPromptAuth}
                className="mt-2 inline-flex items-center justify-center px-3 py-1 min-h-[44px] rounded-lg bg-[#abc4ff] hover:bg-[#b6ccfe] font-bold text-[#1e293b] text-xs shadow-xs"
              >
                Sign In to Create a Listing
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="p-4 sm:p-6 space-y-4">
          {isEditMode && isLoadingListing && (
            <div
              id="edit-listing-loading"
              role="status"
              className="p-3 rounded-xl bg-[#d7e3fc] border border-[#ccdbfd] text-[#1e293b] text-xs font-semibold flex items-center gap-2"
            >
              <RefreshCw className="w-4 h-4 shrink-0 animate-spin" />
              <span>Loading the current listing details…</span>
            </div>
          )}

          {isEditMode && loadListingError && (
            <div
              id="edit-listing-load-error"
              role="alert"
              className="p-3 rounded-xl bg-red-100/90 border border-red-200 text-red-800 text-xs flex items-center gap-2"
            >
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{loadListingError}</span>
            </div>
          )}

          {error && (
            <div className="p-3 rounded-xl bg-red-100/90 border border-red-200 text-red-800 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-bold text-[#1e293b] mb-1">
              Item Title *
            </label>
            <input
              id="listing-title-input"
              type="text"
              required
              placeholder="e.g. Sony WH-1000XM5 Wireless Noise Canceling Headphones"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3.5 py-2.5 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] font-medium placeholder-[#1e293b]/40"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-[#1e293b] mb-1">
              Item Description *
            </label>
            <textarea
              id="listing-description-input"
              required
              rows={3}
              placeholder="Provide condition, specifications, accessories included, and pickup/shipping terms..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3.5 py-2.5 text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] font-medium placeholder-[#1e293b]/40 resize-none"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-[#1e293b] mb-1">
                Starting Price (£) *
              </label>
              <div className="relative">
                <PoundSterling className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
                <input
                  id="listing-starting-price-input"
                  type="number"
                  step="any"
                  min="0.01"
                  required
                  placeholder="100"
                  value={startingPrice}
                  onChange={(e) => setStartingPrice(e.target.value)}
                  className="w-full pl-9 pr-3.5 py-2.5 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] font-bold"
                />
              </div>
              <p className="text-[11px] text-[#1e293b]/60 mt-1">Must be greater than £0</p>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#1e293b] mb-1">
                Contact Phone Number *
              </label>
              <div className="relative">
                <Phone className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
                <input
                  id="listing-phone-input"
                  type="tel"
                  required
                  placeholder="+44 7700 900123"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  className="w-full pl-9 pr-3.5 py-2.5 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] font-medium"
                />
              </div>
              <p className="text-[11px] text-[#1e293b]/60 mt-1">Include your country code (e.g. +44). Used for the WhatsApp contact button.</p>
            </div>
          </div>

          {/* An auction's schedule can't be edited once published (see the PATCH contract), so
              this whole section only applies to creating a new listing. */}
          {!isEditMode && (
          <div>
            <label className="block text-xs font-bold text-[#1e293b] mb-1.5 flex items-center flex-wrap justify-between gap-x-2 gap-y-0.5">
              <span>Auction Duration *</span>
              <span className="text-[11px] font-normal text-[#1e293b]/70">
                Selected: {customDuration ? `${customDuration} minutes` : `${durationMinutes} minutes`}
              </span>
            </label>
            {/* 2 up on a phone, 3 up from `sm`: at 6 across, labels like "2 Mins (Fast Test)"
                had ~80px of cell and wrapped mid-phrase. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {PRESET_DURATIONS.map((preset) => (
                <button
                  key={preset.minutes}
                  type="button"
                  onClick={() => {
                    setDurationMinutes(preset.minutes);
                    setCustomDuration('');
                  }}
                  className={`py-2 px-2 min-h-[44px] text-xs font-semibold leading-tight rounded-xl border text-center transition-all ${
                    durationMinutes === preset.minutes && !customDuration
                      ? 'bg-[#abc4ff] border-[#b6ccfe] text-[#1e293b] shadow-xs'
                      : 'bg-[#edf2fb] border-[#ccdbfd] text-[#1e293b]/80 hover:bg-[#d7e3fc]'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <input
              id="listing-custom-duration-input"
              type="number"
              min="1"
              step="1"
              placeholder="Or enter custom minutes"
              value={customDuration}
              onChange={(e) => setCustomDuration(e.target.value)}
              className="mt-2 w-full px-3.5 py-2 min-h-[44px] text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b]"
            />
          </div>
          )}

          <div>
            <label className="block text-xs font-bold text-[#1e293b] mb-1.5">
              Item Images (Up to 3) *
            </label>
            <div className="mb-2 text-[11px] text-[#1e293b]/65">
              Accepted formats: {ACCEPTED_IMAGE_TYPES_LABEL}. Up to 5&nbsp;MB each. Images are
              compressed and prepared automatically as soon as you pick them.
            </div>

            {imageSlots.length > 0 && (
              <div className="mb-3 grid grid-cols-3 gap-2">
                {imageSlots.map((slot, index) => (
                  <div key={slot.id} className="relative rounded-xl overflow-hidden border border-[#ccdbfd] bg-[#edf2fb]">
                    <img
                      src={slot.previewSrc}
                      alt={`Uploaded preview ${index + 1}`}
                      className={`h-20 sm:h-24 w-full object-cover ${slot.status === 'uploading' || slot.status === 'error' ? 'opacity-40' : ''}`}
                    />

                    {slot.status === 'uploading' && (
                      <div className="absolute inset-0 flex items-center justify-center bg-[#1e293b]/40" role="status">
                        <RefreshCw className="w-5 h-5 text-white animate-spin" aria-hidden="true" />
                        <span className="sr-only">Uploading image {index + 1}…</span>
                      </div>
                    )}

                    {slot.status === 'error' && (
                      <div className="absolute inset-0 flex items-center justify-center bg-red-900/55">
                        <button
                          type="button"
                          onClick={() => retryImageSlot(slot.id)}
                          aria-label={`Retry uploading image ${index + 1}`}
                          className="inline-flex items-center justify-center p-2.5 min-h-[44px] min-w-[44px] rounded-lg bg-white text-red-700 hover:bg-red-50 transition-colors"
                        >
                          <RotateCcw className="w-4 h-4" />
                        </button>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => removeImage(slot.id)}
                      className="absolute top-1 right-1 inline-flex items-center justify-center rounded-md bg-[#1e293b]/70 p-2 min-h-[36px] min-w-[36px] text-white hover:bg-[#1e293b]"
                      aria-label={`Remove image ${index + 1}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Per-image failure detail: kept out of the small thumbnail overlay (which only has
                room for the retry control) so the specific reason -- wrong format vs too large
                vs a dead session -- is both visible and announced to assistive tech, not just
                implied by a red icon. */}
            {imageSlots.some((slot) => slot.status === 'error') && (
              <div className="mb-3 space-y-1.5">
                {imageSlots.map((slot, index) =>
                  slot.status === 'error' ? (
                    <div
                      key={slot.id}
                      id={`image-slot-error-${index}`}
                      role="alert"
                      className="p-2 rounded-lg bg-red-100/90 border border-red-200 text-red-800 text-[11px] flex items-center gap-1.5"
                    >
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      <span className="flex-1">Image {index + 1}: {slot.error}</span>
                    </div>
                  ) : null,
                )}
              </div>
            )}

            {hasUploadInProgress && (
              <div role="status" className="mb-2 text-[11px] font-semibold text-[#1e293b]/70 flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                <span>Uploading image{imageSlots.filter((s) => s.status === 'uploading').length > 1 ? 's' : ''}, please wait…</span>
              </div>
            )}

            {user && imageSlots.length < MAX_IMAGES && !(isEditMode && isLoadingListing) && (
              <label
                htmlFor="listing-images-input"
                className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-[#abc4ff] bg-[#edf2fb] px-3 py-3 min-h-[48px] text-xs font-semibold text-[#1e293b] transition-colors hover:bg-[#d7e3fc]"
              >
                <Upload className="w-4 h-4" />
                <span>Add Image{imageSlots.length > 0 ? 's' : ''}</span>
              </label>
            )}

            <input
              id="listing-images-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              onChange={handleImageSelection}
              className="hidden"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-[#1e293b] mb-1">
              Category
            </label>
            <div className="relative">
              <FileText className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50 pointer-events-none" />
              <select
                id="listing-category-input"
                required
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full pl-9 pr-9 py-2.5 text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] font-bold appearance-none cursor-pointer min-h-[44px]"
              >
                {SELECTABLE_CATEGORIES.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50 pointer-events-none" />
            </div>
          </div>

          {/* Pinned to the bottom of the scroll body so Cancel/Publish stay reachable
              without scrolling to the end of a long form. */}
          <div className="sticky bottom-0 -mx-4 sm:-mx-6 -mb-4 sm:-mb-6 px-4 sm:px-6 py-3 bg-[#e2eafc] flex items-center justify-end gap-3 border-t border-[#ccdbfd]">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center px-4 py-2 min-h-[44px] rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] text-xs font-bold text-[#1e293b] transition-colors"
            >
              Cancel
            </button>
            <button
              id="submit-create-listing-btn"
              type="submit"
              disabled={isSubmitting || !user || hasUploadInProgress || (isEditMode && (isLoadingListing || !!loadListingError))}
              className="px-4 sm:px-5 py-2.5 min-h-[44px] rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-xs font-extrabold text-[#1e293b] shadow-xs transition-colors cursor-pointer disabled:opacity-60 flex items-center justify-center gap-2 text-center"
            >
              {isEditMode ? <PencilLine className="w-4 h-4 shrink-0" /> : <Clock className="w-4 h-4 shrink-0" />}
              <span>
                {isEditMode
                  ? isLoadingListing
                    ? 'Loading...'
                    : hasUploadInProgress
                    ? 'Uploading...'
                    : isSubmitting
                    ? 'Saving...'
                    : 'Save Changes'
                  : hasUploadInProgress
                  ? 'Uploading...'
                  : isSubmitting
                  ? 'Starting Auction...'
                  : 'Publish Live Auction'}
              </span>
            </button>
          </div>
        </form>
        </div>
      </div>
    </div>
  );
};
