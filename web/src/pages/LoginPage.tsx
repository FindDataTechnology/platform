import { Globe, LogIn, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { useAuthStore, withReturnTo } from "@/hooks/useAuth";
import { useAppConfig, useBranding } from "@/hooks/useAppConfig";
import { useLanguage } from "@/i18n/useLanguage";
import type { Locale } from "@/i18n/config";

// Anonymous language switcher: the same useLanguage mechanism Settings →
// General uses (localStorage `platform.locale` + i18n.changeLanguage), so the
// pre-login choice persists exactly like the in-app one.
function LocalePicker() {
  const { locale, locales, changeLocale } = useLanguage();
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Globe className="h-3.5 w-3.5" aria-hidden="true" />
      <select
        value={locale}
        onChange={(e) => changeLocale(e.target.value as Locale)}
        data-testid="login-locale-select"
        aria-label={locale}
        className="rounded-md border border-input bg-background px-1.5 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
      >
        {locales.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function LoginPage() {
  const { t, i18n } = useTranslation();
  const { brand } = useBranding();
  const { companyName, brandIconUrl, loginFooterText } = useAppConfig();
  const auth = useAuthStore();
  const [searchParams] = useSearchParams();
  const authError = searchParams.get("auth_error");
  // The company name personalizes the copy; without one, the deployment brand
  // (assistant name / localized default) keeps the current wording.
  const company = companyName || brand;
  // Logto mode: the server passes ui_locales through to the hosted sign-in
  // page so it opens in the user's picked language. Other modes ignore it.
  const localeSuffix = auth.mode === "logto" ? `&ui_locales=${encodeURIComponent(i18n.language)}` : "";
  const loginUrl = `${withReturnTo(auth.loginUrl, window.location.href)}${localeSuffix}`;

  return (
    <main className="flex h-dvh items-center justify-center bg-background p-6" data-testid="login-page">
      <section className="w-full max-w-md rounded-lg border border-border bg-card p-8 shadow-lg">
        <div className="mb-6 flex items-center gap-3 text-primary-deep">
          {brandIconUrl ? (
            <img src={brandIconUrl} alt="" className="h-8 w-8 rounded object-contain" data-testid="login-brand-icon" />
          ) : (
            <ShieldCheck className="h-8 w-8" aria-hidden="true" />
          )}
          <h1 className="text-xl font-semibold text-foreground">{t("login.title")}</h1>
          <span className="ml-auto">
            <LocalePicker />
          </span>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          {auth.mode === "none" ? t("settings.account.optionalSsoHint") : t("login.description", { company })}
        </p>
        {authError && (
          <p className="mt-4 rounded-md border border-destructive bg-destructive/10 p-3 text-xs text-destructive" role="alert">
            {t(authError === "state" ? "login.stateError" : "login.callbackError")}
          </p>
        )}
        {auth.error && (
          <p className="mt-4 rounded-md border border-destructive bg-destructive/10 p-3 text-xs text-destructive" role="alert">
            {t("login.loadFailed", { error: auth.error })}
          </p>
        )}
        <a
          href={loginUrl}
          data-testid="sso-login"
          className="mt-6 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary-deep px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-deep/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <LogIn className="h-4 w-4" aria-hidden="true" />
          {t("login.action")}
        </a>
        {auth.mode === "none" && (
          <Link
            to="/chat"
            data-testid="login-continue-anonymous"
            className="mt-3 block text-center text-xs text-muted-foreground hover:text-foreground"
          >
            {t("bindings.continueAnonymous")}
          </Link>
        )}
        {loginFooterText && (
          <p className="mt-6 text-center text-xs text-muted-foreground" data-testid="login-footer">
            {loginFooterText}
          </p>
        )}
      </section>
    </main>
  );
}
