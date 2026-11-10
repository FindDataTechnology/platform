// mammoth ships `lib/index.d.ts` but declares no `types` field, so TypeScript
// cannot resolve it. Only the browser build's one entry point is used here.
declare module "mammoth" {
  export interface ConvertResult {
    value: string;
    messages: unknown[];
  }
  export function convertToHtml(input: {
    arrayBuffer: ArrayBuffer;
  }): Promise<ConvertResult>;
}
