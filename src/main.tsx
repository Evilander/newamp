import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './styles/index.css';

if (new URLSearchParams(window.location.search).has('newamp-smoke')) {
  window.addEventListener('error', (event) => {
    console.error('[newamp-smoke-stack]', event.error?.stack ?? event.message);
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
