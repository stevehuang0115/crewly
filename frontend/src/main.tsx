import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/nunito/400.css';
import '@fontsource/nunito/500.css';
import '@fontsource/nunito/600.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import App from './App.tsx';
import './index.css';
import { bootstrapApiToken } from './services/api-token.service';
import { bootstrapOwnerSession } from './services/owner-session.service';

// Consume a one-time `?token=` (from `crewly token --url`), re-sync the cookie
// and install the request interceptors BEFORE any component issues a request.
bootstrapApiToken();
// The owner session (#999): every API write carries the CSRF token; the
// session cookie itself was set by the backend when it served this page.
bootstrapOwnerSession();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);