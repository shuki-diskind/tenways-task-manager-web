// Creates the shared Supabase client (window.sb) from config.js.
// If anything is missing, sb stays null and auth.js shows the setup screen.
(function () {
  'use strict';

  window.sb = null;
  window.setupProblem = null;

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    window.setupProblem =
      'The Supabase library is missing. Open a terminal in the app folder, run "npm install", then restart the app.';
    return;
  }

  var cfg = window.APP_CONFIG;
  function looksFilled(v) {
    return typeof v === 'string' && v.trim() !== '' && !/YOUR-|PASTE-/.test(v);
  }

  if (!cfg || !looksFilled(cfg.SUPABASE_URL) || !looksFilled(cfg.SUPABASE_ANON_KEY)) {
    window.setupProblem = 'config.js is missing or still has its placeholder values.';
    return;
  }

  // supabase-js keeps the session in localStorage; probe it so a broken
  // environment is at least visible in the logs (npm start -- --debug).
  try {
    window.localStorage.setItem('__storage_probe__', '1');
    window.localStorage.removeItem('__storage_probe__');
    console.log('[client] localStorage OK - sessions will persist across launches');
  } catch (e) {
    console.warn('[client] localStorage unavailable - users will have to sign in on every launch');
  }

  window.sb = window.supabase.createClient(cfg.SUPABASE_URL.trim(), cfg.SUPABASE_ANON_KEY.trim());
  console.log('[client] Supabase client created for ' + cfg.SUPABASE_URL.trim());

  // On the hosted web/PWA version, register the service worker so the app
  // shell loads fast and survives flaky connections. Skipped in Electron
  // (file://) where it is neither possible nor needed.
  if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').then(function () {
      console.log('[client] service worker registered');
    }).catch(function (e) {
      console.warn('[client] service worker registration failed: ' + e.message);
    });
  }
})();
