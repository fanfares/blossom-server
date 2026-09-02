/** @jsxImportSource @hono/hono/jsx */
import type { FC } from "@hono/hono/jsx";

const LOGIN_SCRIPT = `
const button = document.getElementById('nostr-login');
const status = document.getElementById('login-status');
button?.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Waiting for your Nostr extension…';
  try {
    if (!window.nostr) throw new Error('No NIP-07 Nostr extension was found.');
    const challengeResponse = await fetch('/admin/auth/challenge', { credentials: 'same-origin' });
    if (!challengeResponse.ok) throw new Error('Could not create a login challenge.');
    const template = await challengeResponse.json();
    const event = await window.nostr.signEvent(template);
    const response = await fetch('/admin/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Nostr authentication failed.');
    window.location.assign(result.redirect);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    button.disabled = false;
  }
});`;

interface LoginPageProps {
  step: "nostr" | "password";
  error?: string;
  pubkey?: string;
}

/** Renders the two-step admin sign-in without exposing either credential to another origin. */
export const LoginPage: FC<LoginPageProps> = ({ step, error, pubkey }) => (
  <html lang="en" class="bg-gray-950 text-gray-100">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>Blossom Admin Sign In</title>
      <link rel="stylesheet" href="/admin.css" />
    </head>
    <body class="min-h-screen flex items-center justify-center p-6">
      <main class="w-full max-w-md rounded-xl border border-gray-800 bg-gray-900 p-7 shadow-2xl">
        <p class="text-xs uppercase tracking-[0.22em] text-purple-400">
          Fanfares Blossom
        </p>
        <h1 class="mt-2 text-2xl font-semibold">Admin verification</h1>
        <p class="mt-2 text-sm text-gray-400">
          {step === "nostr"
            ? "First, prove control of an allowlisted Nostr identity."
            : "Nostr identity verified. Enter the second-factor password."}
        </p>
        {error && (
          <div class="mt-5 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {step === "nostr"
          ? (
            <div class="mt-6">
              <button
                id="nostr-login"
                type="button"
                class="w-full rounded bg-purple-700 px-4 py-3 font-medium hover:bg-purple-600 disabled:opacity-50"
              >
                Continue with Nostr extension
              </button>
              <p
                id="login-status"
                role="status"
                class="mt-3 min-h-5 text-sm text-gray-400"
              >
              </p>
              <script dangerouslySetInnerHTML={{ __html: LOGIN_SCRIPT }} />
            </div>
          )
          : (
            <form method="post" action="/admin/password" class="mt-6 space-y-4">
              <div class="rounded bg-gray-950 px-3 py-2 text-xs text-gray-500">
                Verified pubkey:{" "}
                <code class="break-all text-gray-300">{pubkey}</code>
              </div>
              <label class="block text-sm text-gray-300">
                Admin password
                <input
                  name="password"
                  type="password"
                  required
                  autofocus
                  autocomplete="current-password"
                  class="mt-2 w-full rounded border border-gray-700 bg-gray-950 px-3 py-2 text-gray-100 focus:border-purple-500 focus:outline-none"
                />
              </label>
              <button
                type="submit"
                class="w-full rounded bg-purple-700 px-4 py-3 font-medium hover:bg-purple-600"
              >
                Open admin panel
              </button>
            </form>
          )}
      </main>
    </body>
  </html>
);
