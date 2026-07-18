import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Dashboard } from './app/dashboard';
import './app.css';

const rootElement = document.querySelector('#root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>
);
