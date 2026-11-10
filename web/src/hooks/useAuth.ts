import { create } from "zustand";

export type AuthMode = "none" | "forward_auth" | "logto" | null;

export interface AuthInfo {
  mode: AuthMode;
  email: string | null;
  groups: string[] | null;
  // Deployment-configured admin group names (server ADMIN_GROUPS).
  adminGroups?: string[];
  // The server's composed admin answer (admin group OR stored role flag,
  // role-system D3): preferred over the local group check so the UI agrees
  // with ctx.requireAdmin. Absent on older servers — callers fall back.
  isAdmin?: boolean;
  authenticated: boolean;
  loginUrl: string;
  logoutUrl: string;
  ssoConfigured: boolean;
  ssoAuthenticated: boolean;
  ssoEmail: string | null;
  ssoGroups: string[] | null;
}

interface AuthState extends AuthInfo {
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const initial: AuthInfo = {
  mode: null,
  email: null,
  groups: null,
  authenticated: false,
  loginUrl: "/oauth2/start",
  logoutUrl: "/oauth2/sign_out",
  ssoConfigured: false,
  ssoAuthenticated: false,
  ssoEmail: null,
  ssoGroups: null,
};

export function withReturnTo(path: string, returnTo: string) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}rd=${encodeURIComponent(returnTo)}`;
}

export const useAuthStore = create<AuthState>((set) => ({
  ...initial,
  loading: true,
  error: null,
  refresh: async () => {
    set({ error: null });
    try {
      const response = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as AuthInfo;
      set({ ...data, loading: false, error: null });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "Authentication failed" });
    }
  },
}));
