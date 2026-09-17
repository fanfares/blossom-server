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
  <html lang="en" class="bg-[#030303] text-gray-100">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>Blossom Admin Sign In</title>
      <link rel="stylesheet" href="/admin.css" />
    </head>
    <body class="flex min-h-screen items-center justify-center overflow-hidden bg-[#030303] p-5 antialiased sm:p-8">
      <div class="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.15),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(168,85,247,0.12),_transparent_26%),radial-gradient(circle_at_bottom,_rgba(14,165,233,0.07),_transparent_35%)]" />
      <div class="pointer-events-none fixed inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:72px_72px] opacity-20 [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />
      <main class="relative w-full max-w-lg overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_28px_90px_rgba(0,0,0,0.55)] backdrop-blur-sm">
        <div class="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.12),_transparent_32%),radial-gradient(circle_at_top_right,_rgba(168,85,247,0.10),_transparent_28%)]" />
        <div class="relative p-7 sm:p-9">
          <div class="flex items-center gap-3 text-[11px] uppercase tracking-[0.35em] text-cyan-200/55">
            <span class="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(103,232,249,0.75)]" />
            Fanfares Blossom
          </div>
          <h1 class="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Admin verification
          </h1>
          <p class="mt-3 max-w-md text-sm leading-6 text-gray-400">
            {step === "nostr"
              ? "Prove control of an allowlisted Nostr identity to enter the private moderation workspace."
              : "Nostr identity verified. Complete the second factor to continue."}
          </p>
          <div class="my-7 h-px bg-gradient-to-r from-cyan-300/25 via-white/10 to-transparent" />
          {error && (
            <div class="mb-5 rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}
          {step === "nostr"
            ? (
              <div>
                <button
                  id="nostr-login"
                  type="button"
                  class="w-full rounded-full border border-cyan-300/30 bg-cyan-300/15 px-5 py-3 font-semibold text-cyan-50 shadow-[0_0_0_1px_rgba(34,211,238,0.12)] transition-colors hover:bg-cyan-300/20 disabled:cursor-wait disabled:opacity-50"
                >
                  Continue with Nostr extension
                </button>
                <p
                  id="login-status"
                  role="status"
                  class="mt-4 min-h-5 text-center text-sm text-gray-500"
                >
                </p>
                <script dangerouslySetInnerHTML={{ __html: LOGIN_SCRIPT }} />
              </div>
            )
            : (
              <form method="post" action="/admin/password" class="space-y-5">
                <div class="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-[11px] uppercase tracking-[0.16em] text-gray-500">
                  Verified identity
                  <code class="mt-2 block break-all font-mono text-xs normal-case tracking-normal text-gray-300">
                    {pubkey}
                  </code>
                </div>
                <label class="block text-sm text-gray-300">
                  Admin password
                  <input
                    name="password"
                    type="password"
                    required
                    autofocus
                    autocomplete="current-password"
                    class="mt-2 w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-gray-100 outline-none transition-colors placeholder:text-gray-700 focus:border-cyan-300/40 focus:ring-1 focus:ring-cyan-300/20"
                  />
                </label>
                <button
                  type="submit"
                  class="w-full rounded-full border border-cyan-300/30 bg-cyan-300/15 px-5 py-3 font-semibold text-cyan-50 transition-colors hover:bg-cyan-300/20"
                >
                  Open admin panel
                </button>
              </form>
            )}
          <p class="mt-7 text-center text-[10px] uppercase tracking-[0.24em] text-gray-700">
            Two-factor protected · private access
          </p>
        </div>
      </main>
    </body>
  </html>
);
