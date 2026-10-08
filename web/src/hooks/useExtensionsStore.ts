// Extensions state (MCP servers + custom skills + market catalog + the MCP
// market credential). Fetches REST on mount; subscribes to the
// `extensions_changed` / `market_changed` / `registry_credential_stale` WS events.
import { create } from "zustand";
import * as api from "@platform/core";
import type {
  McpServer,
  Skill,
  MarketCatalog,
  RegistryConnection,
} from "@platform/core";
import type { ServerMessage } from "@platform/core";
import { mintConfigFrom, mintRegistryToken, registrySessionLive } from "@/lib/registry-mint";

interface ExtensionsState {
  mcpServers: McpServer[];
  skills: Skill[];
  marketCatalog: MarketCatalog | null;
  loading: boolean;
  error: string | null;

  // Market credential (registry-sso-credentials). null = not fetched yet.
  registryConnection: RegistryConnection | null;
  connecting: boolean;

  load: () => Promise<void>;
  refreshMcpServers: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  refreshMarketCatalog: () => Promise<void>;
  refreshRegistryConnection: () => Promise<void>;

  addMcpServer: (name: string, config: McpServer["config"], enabled?: boolean) => Promise<void>;
  updateMcpServer: (name: string, config?: McpServer["config"], enabled?: boolean) => Promise<void>;
  removeMcpServer: (name: string) => Promise<void>;
  toggleMcpServer: (name: string, enabled: boolean) => Promise<void>;

  addCustomSkill: (name: string, description: string, content: string, enabled?: boolean) => Promise<void>;
  updateCustomSkill: (name: string, description?: string, content?: string, enabled?: boolean) => Promise<void>;
  removeCustomSkill: (name: string) => Promise<void>;
  toggleCustomSkill: (name: string, enabled: boolean) => Promise<void>;
  installRegistrySkill: (name: string) => Promise<void>;

  connectMarket: () => Promise<void>;
  saveMarketCredential: (token: string, source?: "sso" | "paste") => Promise<void>;
  disconnectMarket: () => Promise<void>;

  applyEvent: (msg: ServerMessage) => void;
}

// The connect flow's login window: the registry's own login page (a shared
// Logto session makes it a silent pass-through). The mint itself runs from THIS
// page once the session appears — the registry's sign-in is its own app and does
// not return to a platform-origin window, so nothing depends on a redirect back.
const LOGIN_WINDOW_FEATURES = "width=520,height=640";
const SESSION_POLL_MS = 1500;
const SESSION_WAIT_MS = 3 * 60 * 1000;

export const useExtensionsStore = create<ExtensionsState>((set, get) => ({
  mcpServers: [],
  skills: [],
  marketCatalog: null,
  loading: false,
  error: null,
  registryConnection: null,
  connecting: false,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [mcpServers, skills] = await Promise.all([
        api.fetchMcpServers(),
        api.fetchSkills(),
      ]);
      set({ mcpServers, skills, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  refreshMcpServers: async () => {
    try {
      const mcpServers = await api.fetchMcpServers();
      set({ mcpServers });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  refreshSkills: async () => {
    try {
      const skills = await api.fetchSkills();
      set({ skills });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  refreshMarketCatalog: async () => {
    try {
      const marketCatalog = await api.fetchMarketCatalog();
      set({ marketCatalog });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  refreshRegistryConnection: async () => {
    try {
      const registryConnection = await api.fetchRegistryConnection();
      set({ registryConnection });
    } catch (err) {
      // An unauthenticated read (auth on, not logged in) or a DB-unavailable
      // server leaves the state unknown rather than claiming "disconnected".
      set({ error: (err as Error).message });
    }
  },

  addMcpServer: async (name, config, enabled = true) => {
    await api.addMcpServer(name, config, enabled);
    await get().refreshMcpServers();
  },

  updateMcpServer: async (name, config, enabled) => {
    await api.updateMcpServer(name, config, enabled);
    await get().refreshMcpServers();
  },

  removeMcpServer: async (name) => {
    await api.removeMcpServer(name);
    await get().refreshMcpServers();
  },

  toggleMcpServer: async (name, enabled) => {
    await api.toggleMcpServer(name, enabled);
    await get().refreshMcpServers();
  },

  addCustomSkill: async (name, description, content, enabled = true) => {
    await api.addCustomSkill(name, description, content, enabled);
    await get().refreshSkills();
  },

  updateCustomSkill: async (name, description, content, enabled) => {
    await api.updateCustomSkill(name, description, content, enabled);
    await get().refreshSkills();
  },

  removeCustomSkill: async (name) => {
    await api.removeCustomSkill(name);
    await get().refreshSkills();
  },

  toggleCustomSkill: async (name, enabled) => {
    await api.toggleCustomSkill(name, enabled);
    await get().refreshSkills();
  },

  installRegistrySkill: async (name) => {
    await api.installRegistrySkill(name);
    await Promise.all([get().refreshSkills(), get().refreshMarketCatalog()]);
  },

  // Silent-SSO connect (design D1): open the registry login in a window (the
  // shared Logto session makes it silent), then mint from this page as soon as
  // the registry session appears. The token goes straight to the backend and is
  // never held in browser storage.
  connectMarket: async () => {
    const conn = get().registryConnection;
    if (!conn?.registryUrl) throw new Error("The MCP market is not configured on this deployment");
    const cfg = mintConfigFrom(conn);
    set({ connecting: true });
    const loginWindow = window.open(`${conn.registryUrl}${conn.loginPath}`, "registry-connect", LOGIN_WINDOW_FEATURES);
    try {
      if (!(await registrySessionLive(cfg))) {
        // Not signed in at the registry yet: the login window takes over. A
        // blocked popup is only fatal when a session is actually needed.
        if (!loginWindow) throw new Error("The connect window was blocked — allow popups for this site");
        const deadline = Date.now() + SESSION_WAIT_MS;
        let live = false;
        while (Date.now() < deadline) {
          if (loginWindow.closed) return; // user closed it — stay silent, no error
          await new Promise((r) => setTimeout(r, SESSION_POLL_MS));
          if (await registrySessionLive(cfg)) {
            live = true;
            break;
          }
        }
        if (!live) throw new Error("Timed out waiting for the registry sign-in");
      }
      await get().saveMarketCredential(await mintRegistryToken(cfg), "sso");
    } finally {
      set({ connecting: false });
      loginWindow?.close();
    }
  },

  saveMarketCredential: async (token, source = "sso") => {
    const registryConnection = await api.saveRegistryCredential(token, source);
    set({ registryConnection });
  },

  disconnectMarket: async () => {
    const registryConnection = await api.disconnectRegistry();
    set({ registryConnection });
  },

  applyEvent: (msg) => {
    if (msg.type === "market_changed") {
      get().refreshMarketCatalog();
      return;
    }
    if (msg.type === "registry_credential_stale") {
      // A 401 from a registry MCP server: re-read the state so the Store shows
      // the re-connect prompt.
      get().refreshRegistryConnection();
      return;
    }
    if (msg.type !== "extensions_changed") return;
    // Refresh the relevant resource on any change event.
    const { resource } = msg as { resource: string };
    if (resource === "mcp") {
      get().refreshMcpServers();
    } else if (resource === "skill") {
      get().refreshSkills();
    }
  },
}));
