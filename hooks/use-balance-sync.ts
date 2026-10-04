'use client';

import { useEffect, useRef } from 'react';
import type { DerivWS } from '@deriv/core';

export interface BalanceUpdate {
  accountId?: string;
  balance: string;
  currency?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeBalance(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function parseBalanceUpdate(message: Record<string, unknown>): BalanceUpdate | null {
  const payload = message.balance;
  const scalarBalance = normalizeBalance(payload);
  if (scalarBalance !== null) return { balance: scalarBalance };
  if (!isRecord(payload)) return null;

  const balance = normalizeBalance(payload.balance);
  if (balance === null) return null;

  const accountId =
    typeof payload.loginid === 'string'
      ? payload.loginid
      : typeof payload.account_id === 'string'
        ? payload.account_id
        : undefined;
  const currency = typeof payload.currency === 'string' ? payload.currency : undefined;

  return { accountId, balance, currency };
}

export function useBalanceSync(
  ws: DerivWS | null,
  isConnected: boolean,
  activeAccountId: string | null,
  onBalanceUpdate: (accountId: string, balance: string, currency?: string) => void
): void {
  const onBalanceUpdateRef = useRef(onBalanceUpdate);
  useEffect(() => {
    onBalanceUpdateRef.current = onBalanceUpdate;
  }, [onBalanceUpdate]);

  // Sync balance via raw Direct WebSocket if workspace hook passes standard socket or active token
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('deriv_token') : null;
    if (!token && (!ws || !isConnected || !activeAccountId)) return;

    let socket: WebSocket | null = null;
    let isDisposed = false;

    // Use direct Deriv WebSocket fallback to ensure balance updates without requiring server OTP proxies
    const connectDirectWs = () => {
      const appId = process.env.NEXT_PUBLIC_DERIV_APP_ID ?? '34yYmvMto9OabbxhKj2Rz';
      socket = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${appId}`);

      socket.onopen = () => {
        if (token && socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ authorize: token }));
        }
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.msg_type === 'authorize') {
            socket?.send(JSON.stringify({ balance: 1, subscribe: 1 }));
          }
          if (data.msg_type === 'balance') {
            const update = parseBalanceUpdate(data);
            if (update) {
              onBalanceUpdateRef.current(
                update.accountId ?? activeAccountId ?? '',
                update.balance,
                update.currency
              );
            }
          }
        } catch {
          // Parse protection
        }
      };
    };

    if (ws && isConnected && activeAccountId) {
      let unsubscribe = () => {};
      ws.subscribe({ balance: 1 }, message => {
        const update = parseBalanceUpdate(message);
        if (!update) return;

        onBalanceUpdateRef.current(
          update.accountId ?? activeAccountId,
          update.balance,
          update.currency
        );
      })
        .then(subscription => {
          if (isDisposed) {
            subscription.unsubscribe();
            return;
          }
          unsubscribe = subscription.unsubscribe;
        })
        .catch(() => {
          connectDirectWs();
        });

      return () => {
        isDisposed = true;
        unsubscribe();
      };
    } else if (token) {
      connectDirectWs();
      return () => {
        isDisposed = true;
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.close();
        }
      };
    }
  }, [ws, isConnected, activeAccountId]);
}
