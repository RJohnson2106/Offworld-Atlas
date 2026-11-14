import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // The oldest browsers with what the map needs: WebGL 2 and module workers.
    target: ['chrome100', 'edge100', 'firefox114', 'safari15.4'],
    chunkSizeWarningLimit: 1500,
  },
});
