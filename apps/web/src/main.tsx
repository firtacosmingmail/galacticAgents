import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { PwaNotices } from './pwa/PwaNotices.js';
import { registerPwa } from './pwa/register.js';

// The installable app (P7-01): the service worker in production builds, the install offer.
registerPwa();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <PwaNotices />
  </StrictMode>,
);
