'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  initiateLogin,
  initiateSignUp,
  handleOAuthCallback,
  refreshAccessToken,
  fetchAccounts,
  getWebSocketOTP,
  logout as coreLogout,
  getAuthInfo,
  getDerivAccounts,
  getActiveLoginId,
  storeDerivAccounts,
  setActiveLoginId,
  setAccountType,
  clearAllAuthData,
  parseReferralLink,
  parseLandingParams,
  resolveReferralViaProxy,
} from '@deriv/core';
import type { AuthInfo, DerivAccount, AuthState, AuthConfig } from '@deriv/core';
import { useAppTranslations } from '@/components/custom/i18n-provider';
import { readStoredLanguage } from '@/lib/i18n';

function getAuthConfig(lang?: string): AuthConfig {
  const config: AuthConfig = {
    clientId: process.env.NEXT_PUBLIC_DERIV_APP_ID ?? '34yYmvMto9OabbxhKj2Rz',
    redirectUri:
      process.env.NEXT_PUBLIC_DERIV_REDIRECT_URI ??
      (typeof window !== 'undefined' ? window.location.origin : ''),
  };

  const resolvedLang = lang ?? readStoredLanguage();
  if (resolvedLang) {
    config.lang = resolvedLang;
  }

  const scopesEnv = process.env.NEXT_PUBLIC_DERIV_OAUTH_SCOPES ?? '';
  if (scopesEnv) {
    config.scopes = scopesEnv
      .split(',')
      .map(s => s.trim())
      .join(' ');
  }

  const referralLink = process.env.NEXT_PUBLIC_DERIV_REFERRAL_LINK ?? '';
  if (referralLink) {
    const referral = parseReferralLink(referralLink);
    if (referral) {
      config.affiliateToken = referral.affiliateToken;
      config.affiliateTokenParam = referral.affiliateTokenParam;
      config.utmCampaign = referral.utmCampaign;
      config.utmSource = referral.utmSource;
      config.utmMedium = referral.utmMedium;
    }
  }

  const landing = parseLandingParams();
  if (landing) {
    if (landing.affiliateToken) {
      config.affiliateToken = landing.affiliateToken;
      config.affiliateTokenParam = landing.affiliateTokenParam;
    }
    if (landing.utmSource) config.utmSource = landing.utmSource;
    if (landing.utmMedium) config.utmMedium = landing.utmMedium;
    if (landing.utmCampaign) config.utmCampaign = landing.utmCampaign;
  }

  return config;
}

let pendingReferral: ReturnType<typeof resolveReferralViaProxy> | null = null;

export function prefetchAuthReferral(): void {
  const referralLink = process.env.NEXT_PUBLIC_DERIV_REFERRAL_LINK ?? '';
  if (!referralLink) return;
  pendingReferral = resolveReferralViaProxy(referralLink);
}

async function getAuthConfigWithReferral(lang?: string): Promise<AuthConfig> {
  const config = getAuthConfig(lang);
  if (!config.affiliateToken) {
    try {
      const referralLink = process.env.NEXT_PUBLIC_DERIV_REFERRAL_LINK ?? '';
      const pending = pendingReferral ?? resolveReferralViaProxy(referralLink);
      pendingReferral = null;
      const resolved = await pending;
      if (resolved) {
        config.affiliateToken = resolved.affiliateToken;
        config.affiliateTokenParam = resolved.affiliateTokenParam;
        if (resolved.utmSource) config.utmSource = resolved.utmSource;
        if (resolved.utmMedium) config.utmMedium = resolved.utmMedium;
        if (resolved.utmCampaign) config.utmCampaign = resolved.utmCampaign;
      }
    } catch {
      // Ignore attribution errors
    }
  }
  return config;
}

export interface UseAuthReturn {
  authState: AuthState;
  accounts: DerivAccount[];
  activeAccount: DerivAccount | null;
  activeAccountId: string | null;
  wsUrl: string | undefined;
  login: () => Promise<void>;
  signUp: () => Promise<void>;
  logout: () => void;
  switchAccount: (accountId: string) => Promise<void>;
  updateAccountBalance: (accountId: string, balance: string, currency?: string) => void;
  error: string | null;
}

export function useAuth(): UseAuthReturn {
  const { currentLang } = useAppTranslations();
  const [authState, setAuthState] = useState<AuthState>(() =>
    typeof window !== 'undefined' && (getAuthInfo() || localStorage.getItem('deriv_token'))
      ? 'authenticated'
      : 'unauthenticated'
  );
  const [accounts, setAccounts] = useState<DerivAccount[]>(() => {
    if (typeof window === 'undefined') return [];
    return getDerivAccounts() ?? [];
  });
  const [activeAccountId, setActiveAccountId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return getActiveLoginId() ?? localStorage.getItem('deriv_account') ?? null;
  });
  const [wsUrl, setWsUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const initRef = useRef(false);
  const activeAccountIdRef = useRef<string | null>(null);
  const tabHiddenAtRef = useRef<number | null>(null);

  const fetchOTPUrl = useCallback(
    async (accountId: string, authInfo: AuthInfo): Promise<string> => {
      return getWebSocketOTP(accountId, authInfo, getAuthConfig().clientId);
    },
    []
  );

  const completeAuth = useCallback(
    async (authInfo: AuthInfo, preferredAccountId?: string | null) => {
      const fetchedAccounts = await fetchAccounts(authInfo, getAuthConfig().clientId);
      setAccounts(fetchedAccounts);

      if (fetchedAccounts.length > 0) {
        const selectedAccount =
          fetchedAccounts.find(account => account.account_id === preferredAccountId) ??
          fetchedAccounts[0];
        setActiveLoginId(selectedAccount.account_id);
        setAccountType(selectedAccount.account_type);
        setActiveAccountId(selectedAccount.account_id);

        try {
          const otpUrl = await fetchOTPUrl(selectedAccount.account_id, authInfo);
          setWsUrl(otpUrl);
        } catch {
          // Fallback to raw WebSocket connection if OTP endpoint is unavailable
        }
      }

      setAuthState('authenticated');
    },
    [fetchOTPUrl]
  );

  const restoreCachedSession = useCallback(
    async (authInfo: AuthInfo): Promise<boolean> => {
      const cachedAccounts = getDerivAccounts();
      const loginId = getActiveLoginId() ?? cachedAccounts?.[0]?.account_id;
      if (!cachedAccounts || cachedAccounts.length === 0 || !loginId) return false;

      const selectedAccount = cachedAccounts.find(a => a.account_id === loginId);
      setActiveLoginId(loginId);
      if (selectedAccount) setAccountType(selectedAccount.account_type);
      setAccounts(cachedAccounts);
      setActiveAccountId(loginId);
      try {
        const otpUrl = await fetchOTPUrl(loginId, authInfo);
        setWsUrl(otpUrl);
        setAuthState('authenticated');
        return true;
      } catch {
        setAuthState('authenticated');
        return true;
      }
    },
    [fetchOTPUrl]
  );

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const init = async () => {
      const url = new URL(window.location.href);
      const searchParams = url.searchParams;

      // Handle raw Deriv OAuth redirect parameters (?acct1=CR123&token1=a1-xxx)
      const token1 = searchParams.get('token1');
      const acct1 = searchParams.get('acct1');
      const cur1 = searchParams.get('cur1');

      if (token1 && acct1) {
        setAuthState('authenticating');
        
        // Extract all accounts passed in URL
        const parsedAccounts: DerivAccount[] = [];
        let index = 1;
        while (searchParams.get(`acct${index}`)) {
          const accId = searchParams.get(`acct${index}`)!;
          const accToken = searchParams.get(`token${index}`)!;
          const accCur = searchParams.get(`cur${index}`) || 'USD';
          const isDemo = accId.startsWith('VRTC');

          parsedAccounts.push({
            account_id: accId,
            token: accToken,
            currency: accCur,
            balance: '0.00',
            account_type: isDemo ? 'demo' : 'real',
          } as unknown as DerivAccount);
          index++;
        }

        // Store tokens & accounts locally
        localStorage.setItem('deriv_token', token1);
        localStorage.setItem('deriv_account', acct1);
        storeDerivAccounts(parsedAccounts);
        setActiveLoginId(acct1);

        setAccounts(parsedAccounts);
        setActiveAccountId(acct1);
        setAuthState('authenticated');

        // Clean query parameters from address bar
        window.history.replaceState({}, document.title, window.location.pathname);
        return;
      }

      // Handle standard PKCE code callback
      const code = searchParams.get('code');
      if (code) {
        setAuthState('authenticating');
        try {
          const authInfo = await handleOAuthCallback(window.location.href, getAuthConfig());
          await completeAuth(authInfo);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Authentication failed');
          setAuthState('error');
          clearAllAuthData();
        }
        return;
      }

      // Existing stored session check
      const storedAuth = getAuthInfo();
      if (storedAuth) {
        if (storedAuth.expires_at && Date.now() / 1000 > storedAuth.expires_at) {
          try {
            const refreshed = await refreshAccessToken(
              storedAuth.refresh_token,
              getAuthConfig().clientId
            );
            await completeAuth(refreshed, getActiveLoginId());
          } catch {
            clearAllAuthData();
            setAuthState('unauthenticated');
          }
          return;
        }

        try {
          await completeAuth(storedAuth, getActiveLoginId());
        } catch {
          if (!(await restoreCachedSession(storedAuth))) {
            clearAllAuthData();
            setAuthState('unauthenticated');
          }
        }
      }
    };

    init();
  }, [completeAuth, fetchOTPUrl, restoreCachedSession]);

  useEffect(() => {
    activeAccountIdRef.current = activeAccountId;
  }, [activeAccountId]);

  useEffect(() => {
    if (authState !== 'authenticated') return;

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'hidden') {
        tabHiddenAtRef.current = Date.now();
        return;
      }

      const hiddenAt = tabHiddenAtRef.current;
      if (!hiddenAt || Date.now() - hiddenAt < 30_000) return;
      tabHiddenAtRef.current = null;

      const accountId = activeAccountIdRef.current;
      const authInfo = getAuthInfo();
      if (!authInfo || !accountId) return;

      try {
        const otpUrl = await fetchOTPUrl(accountId, authInfo);
        setWsUrl(otpUrl);
      } catch {
        // Keep session active
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [authState, fetchOTPUrl]);

  const login = useCallback(async () => {
    const appId = process.env.NEXT_PUBLIC_DERIV_APP_ID ?? '34yYmvMto9OabbxhKj2Rz';
    const redirectUrl = window.location.origin + window.location.pathname;
    window.location.href = `https://oauth.deriv.com/oauth2/authorize?app_id=${appId}&l=${currentLang.toUpperCase()}&brand=deriv`;
  }, [currentLang]);

  const signUp = useCallback(async () => {
    await initiateSignUp(await getAuthConfigWithReferral(currentLang));
  }, [currentLang]);

  const logout = useCallback(() => {
    coreLogout();
    localStorage.removeItem('deriv_token');
    localStorage.removeItem('deriv_account');
    setAccounts([]);
    setActiveAccountId(null);
    setWsUrl(undefined);
    setAuthState('unauthenticated');
    setError(null);
  }, []);

  const switchAccount = useCallback(
    async (accountId: string) => {
      const authInfo = getAuthInfo();
      const account = accounts.find(a => a.account_id === accountId);
      if (account) setAccountType(account.account_type);

      setActiveLoginId(accountId);
      setActiveAccountId(accountId);
      localStorage.setItem('deriv_account', accountId);

      if (authInfo) {
        try {
          const otpUrl = await fetchOTPUrl(accountId, authInfo);
          setWsUrl(otpUrl);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Account switch failed');
        }
      }
    },
    [fetchOTPUrl, accounts]
  );

  const updateAccountBalance = useCallback(
    (accountId: string, balance: string, currency?: string) => {
      setAccounts(currentAccounts => {
        let changed = false;
        const updatedAccounts = currentAccounts.map(account => {
          if (account.account_id !== accountId) return account;

          const updatedCurrency = currency ?? account.currency;
          if (account.balance === balance && account.currency === updatedCurrency) {
            return account;
          }

          changed = true;
          return { ...account, balance, currency: updatedCurrency };
        });

        if (!changed) return currentAccounts;
        storeDerivAccounts(updatedAccounts);
        return updatedAccounts;
      });
    },
    []
  );

  const activeAccount =
    accounts.find(acc => acc.account_id === activeAccountId) ?? accounts[0] ?? null;

  return {
    authState,
    accounts,
    activeAccount,
    activeAccountId,
    wsUrl,
    login,
    signUp,
    logout,
    switchAccount,
    updateAccountBalance,
    error,
  };
}
