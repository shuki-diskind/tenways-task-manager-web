// Sign-in / sign-up screen, session handling, and top-level view switching.
(function () {
  'use strict';

  var sb = window.sb;
  var $ = function (id) { return document.getElementById(id); };

  var VIEWS = ['view-loading', 'view-setup', 'view-auth', 'view-app'];
  function showView(id) {
    VIEWS.forEach(function (v) { $(v).classList.toggle('hidden', v !== id); });
    console.log('[auth] view -> ' + id);
  }

  var mode = 'signin'; // or 'signup' / 'recovery'
  var knownUserId = null;

  // Where "reset my password" emails send people: always the web app —
  // the desktop app cannot receive links, and the web app shares the
  // same accounts. Captured from the URL hash BEFORE supabase-js
  // consumes it, so a reset link lands on the new-password form.
  var RESET_LANDING = 'https://shuki-diskind.github.io/tenways-task-manager-web/';
  var pendingRecovery = /type=recovery/.test(window.location.hash || '');
  var recoveryUser = null;

  function setError(msg) {
    var e = $('auth-error');
    e.textContent = msg || '';
    e.classList.toggle('hidden', !msg);
  }

  function setInfo(msg) {
    var e = $('auth-info');
    e.textContent = msg || '';
    e.classList.toggle('hidden', !msg);
  }

  function applyMode() {
    $('field-name').classList.toggle('hidden', mode !== 'signup');
    $('field-email').classList.toggle('hidden', mode === 'recovery');
    $('forgot-line').classList.toggle('hidden', mode !== 'signin');
    $('ask-admin-line').classList.toggle('hidden', mode === 'recovery');
    $('password-label').textContent = mode === 'recovery' ? 'New password' : 'Password';
    $('auth-submit').textContent = mode === 'signup' ? 'Create account'
      : mode === 'recovery' ? 'Set new password' : 'Sign in';
    $('auth-subtitle').textContent = mode === 'signup'
      ? 'Create your team account'
      : mode === 'recovery'
      ? 'Choose a new password for your account'
      : 'Sign in with your team email';
    $('auth-toggle').textContent = mode === 'signup'
      ? 'Already have an account? Sign in'
      : 'New here? Create an account';
    $('auth-password').setAttribute('autocomplete', mode === 'signin' ? 'current-password' : 'new-password');
    setError(null);
    setInfo(null);
  }

  async function onForgot(e) {
    e.preventDefault();
    var email = $('auth-email').value.trim();
    setError(null);
    setInfo(null);
    if (!email || email.indexOf('@') < 0) {
      setError('Type your email address above first, then press "Forgot your password?" again.');
      return;
    }
    try {
      var res = await sb.auth.resetPasswordForEmail(email, { redirectTo: RESET_LANDING });
      if (res.error) throw res.error;
      setInfo('Password reset email sent to ' + email + ' — open the link inside and you can choose a new password. (Check spam if it does not arrive.)');
    } catch (err) {
      setError(friendlyAuthError(err));
    }
  }

  function friendlyAuthError(err) {
    var m = (err && err.message) || 'Something went wrong.';
    if (/Failed to fetch|NetworkError|fetch failed|ERR_NAME_NOT_RESOLVED/i.test(m)) {
      return 'Could not reach the server. Check your internet connection (and the SUPABASE_URL in config.js).';
    }
    if (/Invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (/Email not confirmed/i.test(m)) {
      return 'This email has not been confirmed yet — open the confirmation link that was emailed to you, then sign in again.';
    }
    if (/Signups not allowed|signup_disabled/i.test(m)) {
      return 'Sign-ups are switched off for this project. Ask the project owner to re-enable them for you.';
    }
    if (/rate limit/i.test(m)) {
      return 'Too many emails were requested just now — wait a few minutes and try again.';
    }
    if (/same.*password|different from the old/i.test(m)) {
      return 'That is already your current password — choose a different one.';
    }
    return m;
  }

  async function onSubmit(e) {
    e.preventDefault();
    var email = $('auth-email').value.trim();
    var password = $('auth-password').value;
    var name = $('auth-name').value.trim();
    setError(null);
    setInfo(null);

    if (mode !== 'recovery' && (!email || email.indexOf('@') < 0)) { setError('Enter a valid email address.'); return; }
    if (!password) { setError('Enter your password.'); return; }
    if ((mode === 'signup' || mode === 'recovery') && password.length < 8) {
      setError('Choose a password of at least 8 characters.');
      return;
    }

    var btn = $('auth-submit');
    btn.disabled = true;
    try {
      if (mode === 'recovery') {
        var up = await sb.auth.updateUser({ password: password });
        if (up.error) throw up.error;
        pendingRecovery = false;
        var u = (up.data && up.data.user) || recoveryUser;
        mode = 'signin';
        $('auth-password').value = '';
        applyMode();
        knownUserId = u ? u.id : knownUserId;
        showView('view-app');
        window.todoApp.start(u);
        return;
      }
      if (mode === 'signup') {
        var su = await sb.auth.signUp({
          email: email,
          password: password,
          options: { data: { display_name: name || email.split('@')[0] } },
        });
        if (su.error) throw su.error;
        // Supabase obfuscates "email already registered" as a user with no identities.
        if (su.data.user && Array.isArray(su.data.user.identities) && su.data.user.identities.length === 0) {
          mode = 'signin';
          applyMode();
          setError('That email is already registered — sign in instead.');
          return;
        }
        if (!su.data.session) {
          // Email confirmation is switched on for this project.
          mode = 'signin';
          applyMode();
          setInfo('Account created. Open the confirmation link that was emailed to you, then sign in here.');
          return;
        }
        // Signed in immediately; onAuthStateChange takes it from here.
      } else {
        var si = await sb.auth.signInWithPassword({ email: email, password: password });
        if (si.error) throw si.error;
      }
    } catch (err) {
      console.log('[auth] error: ' + (err && err.message));
      setError(friendlyAuthError(err));
    } finally {
      btn.disabled = false;
    }
  }

  function start() {
    if (!sb) {
      if (window.setupProblem) $('setup-message').textContent = window.setupProblem;
      showView('view-setup');
      return;
    }

    $('auth-form').addEventListener('submit', onSubmit);
    $('auth-forgot').addEventListener('click', onForgot);
    $('auth-toggle').addEventListener('click', function (e) {
      e.preventDefault();
      mode = mode === 'signin' ? 'signup' : 'signin';
      applyMode();
    });
    $('btn-signout').addEventListener('click', async function () {
      try { await sb.auth.signOut(); } catch (err) { /* local session is cleared regardless */ }
    });

    // Fires INITIAL_SESSION on startup (restored session or none), then
    // SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED as things happen.
    // The real work is deferred with setTimeout(0): supabase-js holds an
    // internal auth lock while running this callback, and issuing further
    // Supabase calls inside it can deadlock.
    sb.auth.onAuthStateChange(function (event, session) {
      console.log('[auth] event: ' + event + (session ? ' (session)' : ' (no session)'));
      if (event === 'PASSWORD_RECOVERY') pendingRecovery = true;
      var uid = session && session.user ? session.user.id : null;
      if (uid && pendingRecovery) {
        // Arrived via a password-reset email: ask for the new password
        // before letting the session into the app.
        recoveryUser = session.user;
        setTimeout(function () {
          mode = 'recovery';
          applyMode();
          showView('view-auth');
        }, 0);
        return;
      }
      if (uid && uid !== knownUserId) {
        knownUserId = uid;
        var user = session.user;
        setTimeout(function () {
          showView('view-app');
          window.todoApp.start(user);
        }, 0);
      } else if (!uid && (knownUserId !== null || event === 'INITIAL_SESSION' || event === 'SIGNED_OUT')) {
        knownUserId = null;
        setTimeout(function () {
          window.todoApp.stop();
          $('auth-password').value = '';
          applyMode();
          showView('view-auth');
        }, 0);
      }
    });
  }

  start();
})();
