import React, { useState } from 'react';
import { X, Tag, Phone, DollarSign, Clock, FileText, Image as ImageIcon, AlertCircle } from 'lucide-react';
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
  { label: '15 Mins', minutes: 15 },
  { label: '1 Hour', minutes: 60 },
  { label: '6 Hours', minutes: 360 },
  { label: '24 Hours', minutes: 1440 },
];

const PRESET_IMAGES = [
  { label: 'Camera', url: 'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=800&q=80' },
  { label: 'Headphones', url: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80' },
  { label: 'Watch', url: 'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?auto=format&fit=crop&w=800&q=80' },
  { label: 'Laptop', url: 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=800&q=80' },
  { label: 'Guitar', url: 'https://images.unsplash.com/photo-1550291652-6ea9114a47b1?auto=format&fit=crop&w=800&q=80' },
];

export const CreateListingModal: React.FC<CreateListingModalProps> = ({
  isOpen,
  user,
  onClose,
  onCreated,
  onPromptAuth,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('+1 (555) 382-9012');
  const [startingPrice, setStartingPrice] = useState<string>('150');
  const [durationMinutes, setDurationMinutes] = useState<number>(5);
  const [customDuration, setCustomDuration] = useState<string>('');
  const [imageUrl, setImageUrl] = useState<string>(PRESET_IMAGES[0].url);
  const [category, setCategory] = useState('Electronics');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!user) {
      onPromptAuth();
      return;
    }

    const priceNum = parseFloat(startingPrice);
    if (isNaN(priceNum) || priceNum <= 0) {
      setError('Starting price must be greater than $0.');
      return;
    }

    const finalDuration = customDuration ? parseInt(customDuration, 10) : durationMinutes;
    if (isNaN(finalDuration) || finalDuration <= 0) {
      setError('Duration must be at least 1 minute.');
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch('/api/auctions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({
          title,
          description,
          phoneNumber,
          startingPrice: priceNum,
          durationMinutes: finalDuration,
          sellerId: user.id,
          sellerName: user.name,
          imageUrl,
          category,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create listing');
      }

      onCreated(data.auction);
      onClose();
    } catch (err: any) {
      setError(err.message || 'An error occurred while creating the listing.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1e293b]/40 backdrop-blur-xs overflow-y-auto">
      <div className="relative w-full max-w-xl bg-[#e2eafc] border border-[#ccdbfd] rounded-2xl shadow-xl overflow-hidden text-[#1e293b] my-8">
        
        {/* Header */}
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

        {/* Warning if not logged in */}
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
                Sign In or Choose Demo User
              </button>
            </div>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 rounded-xl bg-red-100/90 border border-red-200 text-red-800 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Item Title */}
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

          {/* Description */}
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

          {/* 2-Column Row: Starting Price & Phone Number */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-[#1e293b] mb-1">
                Starting Price ($) *
              </label>
              <div className="relative">
                <DollarSign className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
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
              <p className="text-[11px] text-[#1e293b]/60 mt-1">Must be greater than $0</p>
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

          {/* Auction Duration */}
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
          </div>

          {/* Image Presets or Custom URL */}
          <div>
            <label className="block text-xs font-bold text-[#1e293b] mb-1.5">
              Item Image Preview
            </label>
            <div className="flex items-center gap-2 mb-2 overflow-x-auto pb-1">
              {PRESET_IMAGES.map((img) => (
                <button
                  key={img.label}
                  type="button"
                  onClick={() => setImageUrl(img.url)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition-all ${
                    imageUrl === img.url
                      ? 'bg-[#b6ccfe] border-[#abc4ff] text-[#1e293b] font-bold'
                      : 'bg-[#edf2fb] border-[#ccdbfd] text-[#1e293b]/70 hover:bg-[#d7e3fc]'
                  }`}
                >
                  {img.label}
                </button>
              ))}
            </div>
            <div className="relative">
              <ImageIcon className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#1e293b]/50" />
              <input
                id="listing-image-url-input"
                type="url"
                placeholder="Or paste custom image URL (https://...)"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                className="w-full pl-9 pr-3.5 py-2 text-xs rounded-xl bg-[#edf2fb] border border-[#ccdbfd] focus:border-[#abc4ff] focus:outline-hidden text-[#1e293b]"
              />
            </div>
          </div>

          {/* Action Buttons */}
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
