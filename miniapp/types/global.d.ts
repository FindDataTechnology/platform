declare module "*.css";

declare const defineAppConfig: (config: {
  pages: string[];
  window?: Record<string, unknown>;
  [key: string]: unknown;
}) => unknown;

declare const definePageConfig: (config: Record<string, unknown>) => unknown;
