import { LogIn, LogOut, ShieldCheck, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuthStore, withReturnTo } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

export function AccountSection() {
  const { t } = useTranslation();
  const auth = useAuthStore();
  const logoutUrl = withReturnTo(auth.logoutUrl, "/login");

  if (auth.mode === "none") {
    return (
      <div className="flex flex-col gap-3 p-6" data-testid="settings-account">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          {t("settings.account.title")}
        </div>
        {auth.ssoAuthenticated ? (
          <>
            <div className="rounded-md border border-border bg-background p-3">
              <div className="text-xs text-muted-foreground">{t("settings.account.email")}</div>
              <div className="mt-1 truncate text-sm text-foreground" data-testid="account-email">
                {auth.ssoEmail}
              </div>
            </div>
            <a
              href={logoutUrl}
              data-testid="sso-logout"
              className="inline-flex w-fit items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              {t("login.logout")}
            </a>
          </>
        ) : (
          <>
            <p className="text-xs leading-5 text-muted-foreground">{t("settings.account.openHint")}</p>
            {auth.ssoConfigured && (
              <>
                <p className="text-xs leading-5 text-muted-foreground">{t("settings.account.optionalSsoHint")}</p>
                <a
                  href={withReturnTo(auth.loginUrl, window.location.href)}
                  data-testid="sso-login"
                  className="inline-flex w-fit items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent"
                >
                  <LogIn className="h-4 w-4" aria-hidden="true" />
                  {t("login.action")}
                </a>
              </>
            )}
          </>
        )}
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <div className="flex flex-col gap-2 p-6" data-testid="settings-account">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <UserRound className="h-4 w-4" aria-hidden="true" />
          {t("settings.account.title")}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{t("settings.account.signedOutHint")}</p>
        <a href={withReturnTo(auth.loginUrl, window.location.href)} className={cn("mt-2 inline-flex w-fit items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent")}>
          {t("login.action")}
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-6" data-testid="settings-account">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <UserRound className="h-4 w-4" aria-hidden="true" />
        {t("settings.account.title")}
      </div>
      <div className="rounded-md border border-border bg-background p-3">
        <div className="text-xs text-muted-foreground">{t("settings.account.email")}</div>
        <div className="mt-1 truncate text-sm text-foreground" data-testid="account-email">
          {auth.email}
        </div>
      </div>
      <a
        href={logoutUrl}
        data-testid="sso-logout"
        className="inline-flex w-fit items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-accent"
      >
<LogOut className="h-4 w-4" aria-hidden="true" />
      {t("login.logout")}
    </a>
  </div>
);
}
