import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './app/App';
import { queryClient } from './shared/lib/queryClient';
import { ToastProvider } from './shared/ui/toast';
import { reportError } from './shared/lib/errorReporter';
import './shared/styles/tailwind.css';
import './shared/styles/tokens.css';

// Last-resort net for failures no component awaited — without these the
// browser logs them to a console nobody has open and the UI looks fine.
window.addEventListener('unhandledrejection', (event) => {
  reportError(event.reason, { action: 'Background task' });
});
window.addEventListener('error', (event) => {
  if (event.error) reportError(event.error, { action: 'Unexpected error' });
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
