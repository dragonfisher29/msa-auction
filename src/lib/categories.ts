import { Layers, Laptop, Car, Gem, Palette, BookOpen, Shirt, Box } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface CategoryOption {
  id: string;
  label: string;
  icon: LucideIcon;
}

// `All` is a filter-bar pseudo-category, never a value a listing can be saved with.
export const CATEGORIES: CategoryOption[] = [
  { id: 'All', label: 'All Categories', icon: Layers },
  { id: 'Electronics', label: 'Electronics', icon: Laptop },
  { id: 'Vehicles', label: 'Vehicles', icon: Car },
  { id: 'Collectibles', label: 'Collectibles', icon: Gem },
  { id: 'Art & Antiques', label: 'Art & Antiques', icon: Palette },
  { id: 'Books & Media', label: 'Books & Media', icon: BookOpen },
  { id: 'Fashion', label: 'Fashion', icon: Shirt },
  { id: 'General', label: 'General', icon: Box },
];

export const SELECTABLE_CATEGORIES: CategoryOption[] = CATEGORIES.filter((cat) => cat.id !== 'All');
