## 1. Sidebar fix

- [x] 1.1 In `web/src/components/Sidebar.tsx`, replace the `NAV` array's `href: "/"` entries so Dashboard targets `/dashboard`, Documents targets `/documents`, OpenConnector targets `/openconnector`.
- [x] 1.2 Add a LiteLLM entry (`/litellm`) to `NAV`, rendered only when `/api/config` reports `litellmEnabled: true`. Fetch (or reuse an existing fetch of) `/api/config` on mount; hide the entry until the flag is known.

## 2. Verification

- [x] 2.1 Run `npm run web:build` to refresh `web/dist/`.
- [x] 2.2 `npm start`, load `http://localhost:3000/chat/`, click each of Dashboard / Documents / OpenConnector and confirm the corresponding legacy tab opens in the vanilla page (not a bounce back to `/chat/`).
- [x] 2.3 Toggle `LITELLM_BASE_URL` and confirm the LiteLLM link appears/disappears; when present, confirm it opens the LiteLLM tab.
