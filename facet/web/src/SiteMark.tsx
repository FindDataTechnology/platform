// Re-export shim (overhaul-market-catalog-presentation P2): the brand mark's
// single source moved to web/src/components/ui/site-mark.tsx so the market
// cards (PackIdentityMark) and the shell share one definition. Existing shell
// imports keep working verbatim.
export { SiteMark } from "@/components/ui/site-mark";
