import { currentWorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { languageInfo } from "./lib/language";

// Discord rate-limits activity updates to once every 15 seconds per client.
const UPDATE_DEBOUNCE_MS = 15_000;

type ActivityButton = { label: string; url: string };

type Payload = {
  details?: string;
  state?: string;
  large_text?: string;
  small_image?: string;
  small_text?: string;
  started_at_ms?: number;
  buttons?: ActivityButton[];
};

/** Strip credentials and rewrite SSH form to https for Discord button URLs. */
function normalizeRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const ssh = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^https?:\/\//.test(trimmed)) {
    return trimmed
      .replace(/^https?:\/\/[^@/]+@/, "https://")
      .replace(/\.git$/, "");
  }
  return null;
}

function basename(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

// Activity text:
//   details = "Working on <workspace>"
//   state   = "Editing <filename>" whenever the tab has a file context;
//             omitted otherwise (terminal / preview / history).
type Describe = {
  state: string | undefined;
  largeText: string | undefined;
  smallImage: string | undefined;
  smallText: string | undefined;
};

function fileBasename(path: string): string {
  return basename(path) ?? path;
}

function describe(tab: Tab | undefined): Describe {
  if (!tab) {
    return {
      state: undefined,
      largeText: undefined,
      smallImage: undefined,
      smallText: undefined,
    };
  }
  switch (tab.kind) {
    case "editor": {
      const lang = languageInfo(tab.path);
      return {
        state: `Editing ${tab.title}`,
        largeText: lang ? `${lang.label} file` : undefined,
        smallImage: lang?.assetKey ?? undefined,
        smallText: lang?.label,
      };
    }
    case "ai-diff":
    case "git-diff":
    case "git-commit-file": {
      const name = fileBasename(tab.path);
      const lang = languageInfo(tab.path);
      return {
        state: `Editing ${name}`,
        largeText: lang ? `${lang.label} file` : undefined,
        smallImage: lang?.assetKey ?? undefined,
        smallText: lang?.label,
      };
    }
    case "markdown": {
      const lang = languageInfo(tab.path);
      return {
        state: `Editing ${tab.title}`,
        largeText: lang ? `${lang.label} file` : undefined,
        smallImage: lang?.assetKey ?? undefined,
        smallText: lang?.label,
      };
    }
    case "terminal":
    case "preview":
    case "git-history":
    default:
      return {
        state: undefined,
        largeText: undefined,
        smallImage: undefined,
        smallText: undefined,
      };
  }
}

type Options = {
  activeTab: Tab | undefined;
  workspaceRoot: string | null;
};

export function useDiscordPresence({
  activeTab,
  workspaceRoot,
}: Options): void {
  const enabled = usePreferencesStore((s) => s.discordPresenceEnabled);
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const startedAtRef = useRef<number>(Date.now());
  const lastPayloadRef = useRef<string>("");
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<Payload | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const remoteRootRef = useRef<string | null>(null);
  const inviteResolvedRef = useRef<boolean>(false);

  useEffect(() => {
    if (!hydrated) return;
    if (!enabled) {
      lastPayloadRef.current = "";
      pendingRef.current = null;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void invoke("discord_clear_activity").catch(() => undefined);
      return;
    }

    const { state, largeText, smallImage, smallText } = describe(activeTab);
    const workspaceName = basename(workspaceRoot);
    const detailsLine = workspaceName ? `Working on ${workspaceName}` : "Terax";

    if (workspaceRoot && remoteRootRef.current !== workspaceRoot) {
      remoteRootRef.current = workspaceRoot;
      setRemoteUrl(null);
      const root = workspaceRoot;
      void invoke<string | null>("git_remote_url", {
        repoRoot: root,
        name: null,
        workspace: currentWorkspaceEnv(),
      })
        .then((url) => {
          if (remoteRootRef.current !== root) return;
          setRemoteUrl(url ? normalizeRemoteUrl(url) : null);
        })
        .catch(() => undefined);
    }

    if (!inviteResolvedRef.current) {
      inviteResolvedRef.current = true;
      void invoke<string | null>("discord_invite_url")
        .then((url) => setInviteUrl(url ?? null))
        .catch(() => undefined);
    }

    const buttons: ActivityButton[] = [];
    if (remoteUrl) {
      buttons.push({ label: "View Repository", url: remoteUrl });
    }
    if (inviteUrl) {
      buttons.push({ label: "Join Discord", url: inviteUrl });
    }

    const payload: Payload = {
      details: detailsLine,
      state,
      large_text: largeText,
      small_image: smallImage,
      small_text: smallText,
      started_at_ms: startedAtRef.current,
      buttons: buttons.length ? buttons : undefined,
    };

    const key = JSON.stringify(payload);
    if (key === lastPayloadRef.current) return;
    pendingRef.current = payload;

    const send = (p: Payload) => {
      lastPayloadRef.current = JSON.stringify(p);
      void invoke("discord_update_activity", { payload: p }).catch(
        () => undefined,
      );
    };

    if (timerRef.current === null) {
      // Send first change immediately so the toggle feels responsive; later
      // diffs in the same window collapse into a single trailing flush.
      const first = pendingRef.current;
      pendingRef.current = null;
      if (first) send(first);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const trailing = pendingRef.current;
        pendingRef.current = null;
        if (trailing) send(trailing);
      }, UPDATE_DEBOUNCE_MS);
    }
  }, [activeTab, workspaceRoot, enabled, hydrated, remoteUrl, inviteUrl]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void invoke("discord_clear_activity").catch(() => undefined);
    };
  }, []);
}
