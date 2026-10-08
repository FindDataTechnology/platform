// The shell imports live in the main web app's tree: the tailwind token
// sheet and the i18n init (bundled resources, packs.* keys included) are
// single-sourced there.
import "./facet.css";
import "@/i18n";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
