// A moment's word that something took -- "Saved" -- for the settings that
// are always open to edit, where the screen barely changes when they save.
import { create } from "zustand";

interface ToastState {
  message: string | null;
  /// Each toast's own, so an earlier one's timer can't clear a later one.
  id: number;
}

export const useToast = create<ToastState>(() => ({ message: null, id: 0 }));

const SHOWN_MS = 2500;

export function toast(message: string) {
  const id = useToast.getState().id + 1;
  useToast.setState({ message, id });
  setTimeout(() => useToast.setState((s) => (s.id === id ? { message: null } : s)), SHOWN_MS);
}
