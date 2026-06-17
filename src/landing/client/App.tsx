import { useEffect, useState } from "@hono/hono/jsx/dom";
import type { Tab } from "./types.ts";
import { UploadForm } from "./UploadForm.tsx";
import { MirrorForm } from "./MirrorForm.tsx";

type NostrMethod = "nip07" | "auto";

const NOSTR_SESSION_KEY = "blossom.nostr.session";

function shortKey(pubkey: string): string {
  if (pubkey.length < 24) return pubkey;
  return `${pubkey.slice(0, 12)}...${pubkey.slice(-8)}`;
}

export function App({
  requireAuth,
  mediaEnabled,
  mediaRequireAuth,
  mirrorEnabled,
  mirrorRequireAuth,
}: {
  requireAuth: boolean;
  mediaEnabled: boolean;
  mediaRequireAuth: boolean;
  mirrorEnabled: boolean;
  mirrorRequireAuth: boolean;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("upload");
  // Each tab reports whether it has active items so we can hide server-info
  const [uploadHasItems, setUploadHasItems] = useState(false);
  const [mirrorHasItems, setMirrorHasItems] = useState(false);
  const [nostrPubkey, setNostrPubkey] = useState<string | null>(null);
  const [nostrError, setNostrError] = useState<string | null>(null);
  const [authMenuOpen, setAuthMenuOpen] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [authMethod, setAuthMethod] = useState<NostrMethod | null>(null);

  const hasItems = uploadHasItems || mirrorHasItems;

  useEffect(() => {
    const raw = localStorage.getItem(NOSTR_SESSION_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as {
        pubkey?: string;
        method?: NostrMethod;
      };
      if (parsed.pubkey) setNostrPubkey(parsed.pubkey);
      if (parsed.method) setAuthMethod(parsed.method);
    } catch {
      localStorage.removeItem(NOSTR_SESSION_KEY);
    }
  }, []);

  useEffect(() => {
    const el = document.getElementById("server-info");
    if (!el) return;
    el.style.display = hasItems ? "none" : "";
  }, [hasItems]);

  const tabClass = (tab: Tab) =>
    `px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
      activeTab === tab
        ? "border-blue-500 text-white"
        : "border-transparent text-gray-500 hover:text-gray-300"
    }`;

  const connectNostr = async (method: NostrMethod) => {
    setIsConnecting(true);
    setNostrError(null);
    try {
      // deno-lint-ignore no-explicit-any
      const nostr = (globalThis as any).nostr;
      if (!nostr || typeof nostr.getPublicKey !== "function") {
        throw new Error("No Nostr wallet detected. Install Alby or nos2x.");
      }

      const pubkey = await nostr.getPublicKey();
      setNostrPubkey(pubkey);
      setAuthMethod(method);
      setAuthMenuOpen(false);
      localStorage.setItem(
        NOSTR_SESSION_KEY,
        JSON.stringify({ pubkey, method }),
      );
    } catch (err) {
      setNostrError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsConnecting(false);
    }
  };

  const logoutNostr = () => {
    setNostrPubkey(null);
    setAuthMethod(null);
    setNostrError(null);
    setAuthMenuOpen(false);
    localStorage.removeItem(NOSTR_SESSION_KEY);
  };

  return (
    <div>
      <div class="border-b border-white/10 px-6 pt-4 pb-2">
        <div class="flex items-center justify-between gap-4">
          {mirrorEnabled
            ? (
              <div class="flex">
                <button
                  type="button"
                  class={tabClass("upload")}
                  onClick={() => setActiveTab("upload")}
                >
                  Upload
                </button>
                <button
                  type="button"
                  class={tabClass("mirror")}
                  onClick={() => setActiveTab("mirror")}
                >
                  Mirror
                </button>
              </div>
            )
            : <div />}

          <div class="relative">
            <button
              type="button"
              class="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-gray-200 hover:bg-white/[0.07]"
              onClick={() => setAuthMenuOpen((v) => !v)}
            >
              <span
                class={`h-2 w-2 rounded-full ${
                  nostrPubkey ? "bg-emerald-400" : "bg-gray-500"
                }`}
              />
              {nostrPubkey ? shortKey(nostrPubkey) : "Login with Nostr"}
            </button>

            {authMenuOpen && (
              <div class="absolute right-0 z-20 mt-2 w-72 rounded-2xl border border-white/10 bg-[#0b0c0f]/95 p-3 shadow-2xl backdrop-blur-xl">
                <p class="text-[11px] uppercase tracking-[0.2em] text-cyan-300/80">
                  Nostr Account
                </p>

                {!nostrPubkey && (
                  <div class="mt-3 space-y-2">
                    <button
                      type="button"
                      class="w-full rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-left text-sm text-cyan-100 hover:bg-cyan-500/20"
                      onClick={() => connectNostr("nip07")}
                      disabled={isConnecting}
                    >
                      Browser Extension (NIP-07)
                    </button>
                    <button
                      type="button"
                      class="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-left text-sm text-gray-200 hover:bg-white/[0.08]"
                      onClick={() => connectNostr("auto")}
                      disabled={isConnecting}
                    >
                      Auto-detect Wallet
                    </button>
                  </div>
                )}

                {nostrPubkey && (
                  <div class="mt-3 space-y-2">
                    <div class="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                      <p class="text-[11px] text-gray-400">Connected</p>
                      <p class="font-mono text-xs text-gray-200 break-all">
                        {nostrPubkey}
                      </p>
                      {authMethod && (
                        <p class="mt-1 text-[11px] text-gray-500">
                          Method: {authMethod === "nip07" ? "NIP-07" : "Auto"}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      class="w-full rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100 hover:bg-rose-500/20"
                      onClick={logoutNostr}
                    >
                      Log out
                    </button>
                  </div>
                )}

                {nostrError && (
                  <p class="mt-3 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    {nostrError}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tab panels */}
      {activeTab === "upload" && (
        <UploadForm
          requireAuth={requireAuth}
          mediaEnabled={mediaEnabled}
          mediaRequireAuth={mediaRequireAuth}
          onQueueChange={setUploadHasItems}
        />
      )}
      {activeTab === "mirror" && mirrorEnabled && (
        <MirrorForm
          requireAuth={mirrorRequireAuth}
          onQueueChange={setMirrorHasItems}
        />
      )}
    </div>
  );
}
