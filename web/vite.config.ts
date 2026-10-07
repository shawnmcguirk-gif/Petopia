/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// base './': every asset and API path is relative, so the app works at / (engine on :4400) and under Synapse's /petopia/
// prefix (Caddy strips it). Routes are hash routes, so the path never changes. Dev: proxy /api to the engine.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': process.env.ENGINE_URL ?? 'http://localhost:4400' } },
  test: { environment: 'jsdom', globals: false },
});
