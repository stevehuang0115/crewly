import React from 'react';
import { createRoot } from 'react-dom/client';
import { DemoApp } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found in demo index.html');
createRoot(root).render(
  <React.StrictMode>
    <DemoApp />
  </React.StrictMode>,
);
