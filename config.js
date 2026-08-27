// Supabase connection for this app.
//
// Project: shared-todos (shuki-diskind's Org) - created 2026-08-26.
//   - Project URL: Project Settings -> Data API -> Project URL
//   - API key:     Project Settings -> API Keys -> publishable key
//
// The publishable key is safe to ship inside the app: all data access is
// enforced by Row Level Security on the server, and every user still has to
// sign in with their own email + password. NEVER put the service_role or
// "secret" key here.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://fperqegbftyqjwzffrrr.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_dvNOTLyyKnVrmFi46YksDQ_mkUi1hFw',
};
