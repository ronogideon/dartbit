import axios from 'axios';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://dartbit-production.up.railway.app';

// The base domain tenants live under, e.g. "dartbittech.com". When the app is served from
// a subdomain like "acme.dartbittech.com", we derive the tenant subdomain ("acme") from the
// hostname and send it to the backend so it can scope requests to that tenant.
const PORTAL_BASE_DOMAIN = process.env.NEXT_PUBLIC_PORTAL_BASE_DOMAIN || '';

// Returns the tenant subdomain from the current hostname, or '' when on the apex/base
// domain, localhost, or the legacy *.up.railway.app host (no per-tenant subdomain there).
export function tenantSubdomainFromHost(): string {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname.toLowerCase();
  if (!PORTAL_BASE_DOMAIN) return '';
  if (host === PORTAL_BASE_DOMAIN || host === `www.${PORTAL_BASE_DOMAIN}`) return '';
  if (host.endsWith(`.${PORTAL_BASE_DOMAIN}`)) {
    const sub = host.slice(0, host.length - PORTAL_BASE_DOMAIN.length - 1);
    // ignore reserved/app subdomains
    if (sub && !['www', 'api', 'app'].includes(sub)) return sub;
  }
  return '';
}

const api = axios.create({ baseURL: BASE_URL });

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('dartbit_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    // Tell the backend which tenant this request is for, based on the subdomain we're on.
    const sub = tenantSubdomainFromHost();
    if (sub) config.headers['X-Tenant'] = sub;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('dartbit_token');
      localStorage.removeItem('dartbit_user');
      window.location.href = '/auth/login';
    }
    return Promise.reject(err);
  }
);

export const login = (email: string, password: string) =>
  api.post('/auth/login', { email, password }).then((r) => r.data.data);

export const getSubscribers = () => api.get('/subscribers').then((r) => r.data.data);
export const createSubscriber = (data: unknown) => api.post('/subscribers', data).then((r) => r.data.data);
export const updateSubscriber = (id: string, data: unknown) => api.put(`/subscribers/${id}`, data).then((r) => r.data.data);
export const deleteSubscriber = (id: string) => api.delete(`/subscribers/${id}`).then((r) => r.data.data);
export const getSubscriberDetail = (id: string) => api.get(`/subscribers/${id}/detail`).then((r) => r.data.data);
export const extendSubscriber = (id: string, minutes: number) => api.post(`/subscribers/${id}/extend`, { minutes }).then((r) => r.data.data);

export const getPackages = () => api.get('/packages').then((r) => r.data.data);
export const createPackage = (data: unknown) => api.post('/packages', data).then((r) => r.data.data);
export const updatePackage = (id: string, data: unknown) => api.put(`/packages/${id}`, data).then((r) => r.data.data);
export const deletePackage = (id: string) => api.delete(`/packages/${id}`).then((r) => r.data.data);

export const getPayments = () => api.get('/payments').then((r) => r.data.data);
export const createPayment = (data: unknown) => api.post('/payments', data).then((r) => r.data.data);
export const deletePayment = (id: string) => api.delete(`/payments/${id}`).then((r) => r.data.data);

// (Messages helpers — see bottom of file for the typed versions)

export const getRouters = () => api.get('/mikrotiks').then((r) => r.data.data);
export const linkRouter = (data: unknown) => api.post('/mikrotiks/link', data).then((r) => r.data.data);
export const updateRouter = (id: string, data: unknown) => api.put(`/mikrotiks/${id}`, data).then((r) => r.data.data);
export const deleteRouter = (id: string) => api.delete(`/mikrotiks/${id}`).then((r) => r.data.data);
export const getProvisionConfig = (routerId: string) => api.get(`/router/provision/${routerId}`).then((r) => r.data.data);
export const saveProvisionConfig = (routerId: string, data: unknown) => api.post(`/router/provision/${routerId}`, data).then((r) => r.data.data);

export const getOnlineSessions = () => api.get('/online-sessions').then((r) => r.data.data);

export const getTenants = () => api.get('/tenants').then((r) => r.data.data);
export const getTenantStats = () => api.get('/tenants/stats').then((r) => r.data.data);
export const createTenant = (data: unknown) => api.post('/tenants', data).then((r) => r.data.data);
export const deleteTenant = (id: string) => api.delete(`/tenants/${id}`).then((r) => r.data.data);

export const getSettings = () => api.get('/settings').then((r) => r.data.data);
export const updateSettings = (data: unknown) => api.put('/settings', data).then((r) => r.data.data);
export const getBillingCurrent = () => api.get('/billing/current').then((r) => r.data.data);
export const getBillingHistory = () => api.get('/billing/history').then((r) => r.data.data);
export const billingCheckout = () => api.post('/billing/checkout', {}).then((r) => r.data.data);
export const billingVerify = (reference: string) => api.get(`/billing/verify/${reference}`).then((r) => r.data.data);
export const getSystemUsers = () => api.get('/users').then((r) => r.data.data);
export const createSystemUser = (data: { name: string; email: string; role: string }) => api.post('/users', data).then((r) => r.data.data);
export const updateSystemUser = (id: string, data: { name?: string; role?: string; isActive?: boolean }) => api.put(`/users/${id}`, data).then((r) => r.data.data);
export const resetSystemUserPassword = (id: string) => api.post(`/users/${id}/reset-password`, {}).then((r) => r.data.data);
export const deleteSystemUser = (id: string) => api.delete(`/users/${id}`).then((r) => r.data.data);
export const getPaymentConfig = () => api.get('/payment-config').then((r) => r.data.data);
export const updatePaymentConfig = (data: unknown) => api.put('/payment-config', data).then((r) => r.data.data);

export default api;

// Signup
export const signupISP = (data: unknown) => api.post('/signup', data).then(r => r.data.data);
export const checkSubdomain = (name: string) => api.get(`/signup/check-subdomain?name=${encodeURIComponent(name)}`).then(r => r.data.data);

// Tenant info
export const getTenantInfo = () => api.get('/tenants/my').then(r => r.data.data);

// Router actions
export const rebootRouter = (id: string) => api.post(`/mikrotiks/${id}/reboot`).then(r => r.data.data);
export const reprovisionRouter = (id: string) => api.post(`/mikrotiks/${id}/reprovision`).then(r => r.data.data);
export const runRouterCommand = (id: string, command: string) => api.post(`/mikrotiks/${id}/command`, { command }).then(r => r.data.data);
export const changeRouterIdentity = (id: string, identity: string) => api.post(`/mikrotiks/${id}/identity`, { identity }).then(r => r.data.data);
export const updateRouterLanPorts = (id: string, ports: string[]) => api.post(`/mikrotiks/${id}/lan-ports`, { ports }).then(r => r.data.data);
export const getRouterInterfaces = (id: string) => api.get(`/router/list-interfaces/${id}`).then(r => r.data.data);
export const getRouterZtpCommand = (id: string) => api.get(`/mikrotiks/${id}/ztp-command`).then(r => r.data.data);

// Vouchers
export const getVouchers = () => api.get('/vouchers').then(r => r.data.data);
export const getVoucherBatches = () => api.get('/vouchers/batches').then(r => r.data.data);
export const generateVouchers = (data: { count: number; packageId?: string; routerId?: string; durationMinutes: number; codeLength?: number; notes?: string }) =>
  api.post('/vouchers/generate', data).then(r => r.data.data);
export const deleteVoucher = (id: string) => api.delete(`/vouchers/${id}`).then(r => r.data.data);
export const deleteVoucherBatch = (batchId: string) => api.delete(`/vouchers/batch/${batchId}`).then(r => r.data.data);

// Notifications / SMS
export interface MessageTemplate {
  key: string;
  group: 'hotspot' | 'pppoe' | 'system';
  label: string;
  description: string;
  placeholders: string[];
  default: string;
  value: string;
  isCustom: boolean;
}
export interface NotificationConfig {
  gateway: 'DARTBIT' | 'CUSTOM';
  apiKey: string | null;
  apiKeyMasked: string | null;
  senderId: string | null;
  sendWelcome: boolean;
  sendPaymentReceipt: boolean;
  sendExpiryReminders: boolean;
  reminderOffsets: number[];
  templates: MessageTemplate[];
  alertPhones: string[];
  routerOfflineAlert: boolean;
  lowBalanceAlert: boolean;
  lowBalanceThreshold: number;
  dartbitAvailable: boolean;
}
export const getNotificationConfig = () =>
  api.get('/notifications/config').then(r => r.data.data as NotificationConfig);
// Save accepts templates as a key->value map (only overrides), plus the other fields.
export const saveNotificationConfig = (data: Record<string, unknown>) =>
  api.put('/notifications/config', data).then(r => r.data.data as NotificationConfig);
export interface SmsBalance {
  mode: 'WALLET' | 'CUSTOM';
  balance: number;          // SMS count remaining (both modes)
  balanceKES?: number;      // wallet KES (WALLET mode)
  rate?: number;            // KES per SMS (WALLET mode)
  smsRemaining?: number;    // SMS the wallet buys (WALLET mode)
  ok?: boolean;
}
export const getSmsBalance = () =>
  api.get('/notifications/balance').then(r => r.data.data as SmsBalance);
export const topupSms = (amount: number, phone: string) =>
  api.post('/notifications/topup', { amount, phone }).then(r => r.data.data as { transactionId: string; message: string });
export const getTopupStatus = (txId: string) =>
  api.get(`/notifications/topup-status/${txId}`).then(r => r.data.data as { status: string; amount: number });
export const getWalletLedger = () =>
  api.get('/notifications/wallet/ledger').then(r => r.data.data as { id: string; type: string; amount: number; balanceAfter: number; note?: string; createdAt: string }[]);
export const sendTestSms = (phone: string, message: string) =>
  api.post('/notifications/test', { phone, message }).then(r => r.data.data);

// Messages (extended fields)
export interface MessageRow {
  id: string;
  type: string;
  recipient: string;
  body: string;
  status: string;
  gateway?: string | null;
  gatewayMsgId?: string | null;
  cost: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  subscriberId?: string | null;
  username?: string | null;
  category?: string | null;
  createdAt: string;
}
export const getMessages = () => api.get('/messages').then(r => r.data.data as MessageRow[]);
export const sendMessage = (recipient: string, body: string) =>
  api.post('/messages', { type: 'SMS', recipient, body }).then(r => r.data.data as MessageRow);
