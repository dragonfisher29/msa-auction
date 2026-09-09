import React, { useEffect, useState } from 'react';
import { X, Tag, Phone, PoundSterling, Clock, FileText, Image as ImageIcon, AlertCircle, Trash2, Upload } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { User, AuctionItem } from '../types';

interface CreateListingModalProps {
  isOpen: boolean;
  user: User | null;
  onClose: () => void;
  onCreated: (auction: AuctionItem) => void;
  onPromptAuth: () => void;
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
const MAX_IMAGE_DIMENSION = 1600;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const readFileAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
  reader.readAsDataURL(file);
});

const compressImage = async (file: File): Promise<string> => {
  if (!file.type.startsWith('image/')) {
    throw new Error(`${file.name} is not a valid image file.`);
  }

  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`${file.name} is too large. Please upload images up to 5 MB each.`);
  }

  const source = await readFileAsDataUrl(file);

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not process ${file.name}.`));
    img.src = source;
  });

  const canvas = document.createElement('canvas');
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(image.width, image.height));
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const targetHeight = Math.max(1, Math.round(image.height * scale));

  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error(`Could not create a preview for ${file.name}.`);
  }

  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const quality = file.size > 1_000_000 ? 0.72 : 0.85;

  return canvas.toDataURL(mimeType, quality);
};

export const CreateListingModal: React.FC<CreateListingModalProps> = ({
  isOpen,
  user,
  onClose,
  onCreated,
  onPromptAuth,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [startingPrice, setStartingPrice] = useState<string>('150');
  const [durationMinutes, setDurationMinutes] = useState<number>(5);
  const [customDuration, setCustomDuration] = useState<string>('');
  const [category, setCategory] = useState('Electronics');
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setPhoneNumber('');
    setStartingPrice('150');
    setDurationMinutes(5);
    setCustomDuration('');
    setCategory('Electronics');
    setImagePreviews([]);
    setError(null);
    setIsSubmitting(false);
  };

  useEffect(() => {
    if (isOpen) {
      resetForm();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleImageSelection = async (evt: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(evt.target.files ?? []).filter((entry): entry is File => entry instanceof File);
    evt.target.value = '';

    if (files.length === 0) {
      return;
    }

    const remainingSlots = MAX_IMAGES - imagePreviews.length;
    if (files.length > remainingSlots) {
      setError(`You can upload up to ${MAX_IMAGES} images total. Please choose ${remainingSlots} or fewer file(s).`);
      return;
    }

    try {
      setError(null);
      const compressed = await Promise.all(files.map((file) => compressImage(file)));
      setImagePreviews((current) => [...current, ...compressed]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to process the selected images.');
    }
  };

  const removeImage = (indexToRemove: number) => {
    setImagePreviews((current) => current.filter((_, index) => index !== indexToRemove));
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!user) {
      onPromptAuth();
      return;
    }

    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    const trimmedPhoneNumber = phoneNumber.trim();

    if (!trimmedTitle || !trimmedDescription || !trimmedPhoneNumber) {
      setError('Please complete the title, description, and phone number fields.');
      return;
    }

    if (imagePreviews.length === 0) {
      setError('Please upload at least one image before publishing the listing.');
      return;
    }

    const priceNum = Number(startingPrice);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      setError('Starting price must be greater than £0.');
      return;
    }

    const finalDuration = customDuration ? parseInt(customDuration, 10) : durationMinutes;
    if (!Number.isInteger(finalDuration) || finalDuration <= 0) {
      setError('Duration must be at least 1 minute.');
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await apiFetch('/api/auctions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({
          title: trimmedTitle,
          description: trimmedDescription,
          phoneNumber: trimmedPhoneNumber,
          startingPrice: priceNum,
          durationMinutes: finalDuration,
          sellerId: user.id,
          sellerName: user.name,
          imageUrls: imagePreviews,
          imageUrl: imagePreviews[0],
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
      setError(err instanceof Error ? err.message : 'An error occurred while creating the listing.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1e293b]/40 backdrop-blur-xs overflow-y-auto">
      <div className="relative w-full max-w-xl bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl shadow-xl overflow-hidden text-[#1e293b] my-8">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#ccdbfd] bg-[#d7e3fc]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#b6ccfe] flex items-center justify-center text-[#1e293b]">
              <Tag className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-[#1e293b]">Create New Auction Listing</h2>
              <p className="text-xs text-[#1e293b]/70">Publish an item for real-time live bidding</p>
            </div>
          </div>
          <button
            id="close-create-modal-btn"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#1e293b]/70 hover:text-[#1e293b] hover:bg-[#c1d3fe] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {!user && (
          <div className="m-6 p-4 rounded-xl bg-[#d7e3fc] border border-[#ccdbfd] flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-[#1e293b] shrink-0 mt-0.5" />
            <div className="text-xs">
              <p className="font-bold text-[#1e293b]">Sign in required to create listings</p>
              <p className="text-[#1e293b]/80 mt-0.5">
                You must be signed in with a username to host an auction.
              </p>
              <button
                type="button"
                onClick={onPromptAuth}
                className="mt-2 px-3 py-1 rounded-lg bg-[#abc4ff] hover:bg-[#b6ccfe] font-bold text-[#1e293b] text-xs shadow-xs"
              >
                Sign In to Create a Listing
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
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
              className="w-full px-3.5 py-2.5 text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] font-medium placeholder-[#1e293b]/40"
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
                  className="w-full pl-9 pr-3.5 py-2.5 text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] font-bold"
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
                  placeholder="+1 (555) 000-0000"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  className="w-full pl-9 pr-3.5 py-2.5 text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] font-medium"
                />
              </div>
              <p className="text-[11px] text-[#1e293b]/60 mt-1">Displayed to verified bidders</p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-[#1e293b] mb-1.5 flex items-center justify-between">
              <span>Auction Duration *</span>
              <span className="text-[11px] font-normal text-[#1e293b]/70">
                Selected: {customDuration ? `${customDuration} minutes` : `${durationMinutes} minutes`}
              </span>
            </label>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {PRESET_DURATIONS.map((preset) => (
                <button
                  key={preset.minutes}
                  type="button"
                  onClick={() => {
                    setDurationMinutes(preset.minutes);
                    setCustomDuration('');
                  }}
                  className={`py-2 px-1 text-xs font-semibold rounded-xl border text-center transition-all ${
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
              className="mt-2 w-full px-3.5 py-2 text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b]"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-[#1e293b] mb-1.5">
              Item Images (Up to 3) *
            </label>
            <div className="mb-2 text-[11px] text-[#1e293b]/65">
              Upload up to 3 images. Files are compressed automatically before they are stored.
            </div>

            {imagePreviews.length > 0 && (
              <div className="mb-3 grid grid-cols-3 gap-2">
                {imagePreviews.map((preview, index) => (
                  <div key={`${preview.slice(0, 20)}-${index}`} className="relative rounded-xl overflow-hidden border border-[#ccdbfd] bg-[#edf2fb]">
                    <img src={preview} alt={`Uploaded preview ${index + 1}`} className="h-20 w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removeImage(index)}
                      className="absolute top-1 right-1 rounded-md bg-[#1e293b]/70 p-1 text-white hover:bg-[#1e293b]"
                      aria-label={`Remove image ${index + 1}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {imagePreviews.length < MAX_IMAGES && (
              <label
                htmlFor="listing-images-input"
                className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-[#abc4ff] bg-[#edf2fb] px-3 py-3 text-xs font-semibold text-[#1e293b] transition-colors hover:bg-[#d7e3fc]"
              >
                <Upload className="w-4 h-4" />
                <span>Add Image{imagePreviews.length > 0 ? 's' : ''}</span>
              </label>
            )}

            <input
              id="listing-images-input"
              type="file"
              accept="image/*"
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
              <FileText className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
              <input
                id="listing-category-input"
                type="text"
                placeholder="e.g. Electronics"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full pl-9 pr-3.5 py-2.5 text-sm rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b] font-medium placeholder-[#1e293b]/40"
              />
            </div>
          </div>

          <div className="pt-3 flex items-center justify-end gap-3 border-t border-[#ccdbfd]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-[#d7e3fc] hover:bg-[#c1d3fe] text-xs font-bold text-[#1e293b] transition-colors"
            >
              Cancel
            </button>
            <button
              id="submit-create-listing-btn"
              type="submit"
              disabled={isSubmitting || !user}
              className="px-5 py-2.5 rounded-xl bg-[#abc4ff] hover:bg-[#b6ccfe] border border-[#c1d3fe] text-xs font-extrabold text-[#1e293b] shadow-xs transition-colors cursor-pointer disabled:opacity-60 flex items-center gap-2"
            >
              <Clock className="w-4 h-4" />
              <span>{isSubmitting ? 'Starting Auction...' : 'Publish Live Auction'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
