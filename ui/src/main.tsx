import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/command-palette.css';
import './styles/toasts.css';
import './styles/markdown.css';
import App from './App';
import './styles/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
