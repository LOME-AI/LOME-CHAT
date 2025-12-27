import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ModelState {
  selectedModelId: string;
  setSelectedModelId: (modelId: string) => void;
}

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      selectedModelId: 'openai/gpt-4-turbo',
      setSelectedModelId: (modelId) => set({ selectedModelId: modelId }),
    }),
    {
      name: 'lome-model-storage',
    }
  )
);
