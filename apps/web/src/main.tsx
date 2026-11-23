import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/tokens.css';
import './styles/shell.css';

const root = document.getElementById('root');
if (root === null) throw new Error('falta #root en index.html');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
