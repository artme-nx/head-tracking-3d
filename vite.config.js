import { defineConfig } from 'vite';

// Na GitHub Pages stranica živi pod /head-tracking-3d/, lokalno pod / (preview builda isto kao Pages).
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/head-tracking-3d/' : '/',
  server: { open: true, port: 5180 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
  },
}));
