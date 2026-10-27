import './i18n';

import { EA, EAEvents } from '@core/bindings';
import { Buffer } from 'buffer';
import posthog from 'posthog-js';
import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { BUILD, IS_DEV, POSTHOG_HOST, POSTHOG_TOKEN, VERSION } from './config';

// Bind global objects for actions
window.EA = EA;
window.EAEvents = EAEvents;

// Catch alt key to avoid to open menu
window.addEventListener('keydown', (e) => {
  if (e.altKey) {
    e.preventDefault();
  }
});

// PostHog is only started once the user opts in, so nothing is sent or stored before that.
// It must never run code from the network: no remote config script, flags, surveys or recordings.
let isPosthogStarted = false;
const startPosthog = () => {
  if (isPosthogStarted) {
    return;
  }
  posthog.init(POSTHOG_TOKEN, {
    api_host: POSTHOG_HOST,
    person_profiles: 'always',
    autocapture: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_external_dependency_loading: true,
    advanced_disable_flags: true,
    opt_out_capturing_by_default: true,
  });
  posthog.register({
    app_version: VERSION,
    app_build: BUILD,
  });
  isPosthogStarted = true;
};

window.setTelemetryEnabled = (enabled) => {
  try {
    if (!IS_DEV && POSTHOG_TOKEN) {
      if (enabled) {
        startPosthog();
        posthog.opt_in_capturing();
      } else if (isPosthogStarted) {
        posthog.opt_out_capturing();
      }
    }
  } catch (err) {} // eslint-disable-line no-empty
};

window.track = (eventName, data = {}) => {
  try {
    if (!IS_DEV && POSTHOG_TOKEN && isPosthogStarted) {
      console.log(`📊 Tracking event: ${eventName}`, data);
      posthog.capture(eventName, data);
    }
  } catch (err) {} // eslint-disable-line no-empty
};

window.trackException = (error) => {
  try {
    if (!IS_DEV && POSTHOG_TOKEN && isPosthogStarted) {
      console.log(`📊 Tracking exception:`, error);
      posthog.captureException(error);
    }
  } catch (err) {} // eslint-disable-line no-empty
};

globalThis.Buffer = Buffer;

console.log('🚀 Build', BUILD);

// Add service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Web (Web browser backend)
    if (typeof window.IPC === 'undefined') {
      navigator.serviceWorker.register('./sw.js', {
        type: 'module',
      });
    }
  });
}

const container = document.getElementById('root');
const root = createRoot(container);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
