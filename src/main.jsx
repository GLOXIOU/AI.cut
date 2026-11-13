import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles/app.css';
import { App } from './app/App.jsx';
import { MonitorApp } from './components/player/Monitor.jsx';
import { t } from './app/i18n.js';

class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error(error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#fca5a5', fontFamily: 'Inter, sans-serif' }}>
          <h2>{t('crashTitle')}</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#ddd' }}>{String(this.state.error?.stack || this.state.error)}</pre>
          <button onClick={() => this.setState({ error: null })}>{t('retry')}</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// the same page serves the editor and the external program monitor (second screen)
const isMonitor = window.location.hash === '#monitor';
createRoot(document.getElementById('root')).render(<ErrorBoundary>{isMonitor ? <MonitorApp /> : <App />}</ErrorBoundary>);
