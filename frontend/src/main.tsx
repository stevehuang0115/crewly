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

// Consume a one-time `?token=` (from `crewly token --url`), re-sync the cookie
// and install the request interceptors BEFORE any component issues a request.
bootstrapApiToken();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);