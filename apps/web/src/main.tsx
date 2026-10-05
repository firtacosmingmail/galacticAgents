import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { PwaNotices } from './pwa/PwaNotices.js';
import { registerPwa } from './pwa/register.js';
import { wireNotificationClicks } from './pwa/notification-clicks.js';

// The installable app (P7-01): the service worker in production builds, the install offer.
registerPwa();
// Taps on notifications the worker shows (P7-04): a push, or the page's own through the worker.
wireNotificationClicks();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <PwaNotices />
  </StrictMode>,
);
