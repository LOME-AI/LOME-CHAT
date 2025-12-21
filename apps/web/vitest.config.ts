import { defineProject } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineProject({
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
