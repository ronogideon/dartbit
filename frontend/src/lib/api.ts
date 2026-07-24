import axios from 'axios';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://api.dartbittech.com';

// The base domain tenants live under, e.g. "dartbittech.com". When the app is served from
// a subdomain like "acme.dartbittech.com", we derive the tenant subdomain ("acme") from the
// hostname and send it to the backend so it can scope requests to that tenant.
const PORTAL_BASE_DOMAIN = (process.env.NEXT_PUBLIC_PORTAL_BASE_DOMAIN || 'dartbittech.com').toLowerCase();

const RESERVED_SUBS = ['www', 'api', 'app', 'admin', 'superadmin'];

// Returns the tenant subdomain from the current hostname, or '' when on the apex/base
// domain, localhost, or a Railway preview host (no per-tenant subdomain there).
export function tenantSubdomainFromHost(): string {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname.toLowerCase();

  // No subdomains on localhost or Railway preview hosts.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.up.railway.app') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return '';
  }

  // Preferred: derive against the known base domain.
  if (host === PORTAL_BASE_DOMAIN || host === `www.${PORTAL_BASE_DOMAIN}`) return '';
  if (host.endsWith(`.${PORTAL_BASE_DOMAIN}`)) {
    const sub = host.slice(0, host.length - PORTAL_BASE_DOMAIN.length - 1);
    // Only the first label counts as the tenant (acme.dartbittech.com -> "acme").
    const first = sub.split('.')[0];
    if (first && !RESERVED_SUBS.includes(first)) return first;
    return '';
  }

  // Structural fallback: any host with 3+ labels (sub.domain.tld) is treated as having a
  // subdomain even if the base-domain env var doesn't match, so detection still works.
  const labels = host.split('.');
  if (labels.length >= 3) {
    const first = labels[0];
    if (first && !RESERVED_SUBS.includes(first)) return first;
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
    // A 401 from a LOGIN attempt is expected (wrong credentials, or the admin-probe that the portal
    // runs before trying customer login). Those must be handled locally by the caller's catch — NOT
    // trigger the global "session expired" redirect, which otherwise bounces /portal → /auth → /portal
    // and blocks login entirely. Only redirect on 401s from genuinely authenticated calls.
    const url: string = err.config?.url || '';
    const isLoginCall = /\/(auth\/login|portal\/login|auth\/subscriber-login|auth\/subscriber-login-hotspot|auth\/forgot-password|auth\/reset-password)/.test(url);
    if (err.response?.status === 401 && !isLoginCall && typeof window !== 'undefined') {
      localStorage.removeItem('dartbit_token');
      localStorage.removeItem('dartbit_user');
      window.location.href = '/auth/login';
    }
    return Promise.reject(err);
  }
);

export const login = (email: string, password: string) =>
  api.post('/auth/login', { email, password }).then((r) => r.data.data);
// Customer portal login (subscriber username + password), scoped to the current subdomain.
export const portalLogin = (username: string, password: string) =>
  api.post('/portal/login', { username, password }).then((r) => r.data);

export const getSubscribers = () => api.get('/subscribers').then((r) => r.data.data);
export const bulkDeleteSubscribers = (ids: string[]) => api.post('/subscribers/bulk-delete', { ids }).then((r) => r.data.data as { deleted: number });
export const analyzeImport = (csv: string) => api.post('/subscribers/import/analyze', { csv }).then((r) => r.data.data as { totalRows: number; packageColumn: string | null; values: { name: string; count: number }[]; detected: Record<string, boolean> });
export const importSubscribers = (csv: string, mapping?: Record<string, unknown>) => api.post('/subscribers/import', { csv, mapping }).then((r) => r.data.data as { imported: number; skipped: number; unparsedExpiry?: number; total?: number; createdPackages?: string[]; message?: string });
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
export const editPayment = (id: string, data: { amount?: number; notes?: string }) => api.patch(`/payments/${id}`, data).then((r) => r.data.data);
export const deletePayment = (id: string) => api.delete(`/payments/${id}`).then((r) => r.data.data);

// (Messages helpers — see bottom of file for the typed versions)

export const getRouters = () => api.get('/mikrotiks').then((r) => r.data.data);
export const linkRouter = (data: unknown) => api.post('/mikrotiks/link', data).then((r) => r.data.data);
export const updateRouter = (id: string, data: unknown) => api.put(`/mikrotiks/${id}`, data).then((r) => r.data.data);
export const deleteRouter = (id: string) => api.delete(`/mikrotiks/${id}`).then((r) => r.data.data);
export const getProvisionConfig = (routerId: string) => api.get(`/router/provision/${routerId}`).then((r) => r.data.data);
export const saveProvisionConfig = (routerId: string, data: unknown) => api.post(`/router/provision/${routerId}`, data).then((r) => r.data.data);
export const getRouterOverview = (id: string) => api.get(`/mikrotiks/${id}/overview`).then((r) => r.data.data);
export const openWinbox = (id: string) => api.post(`/mikrotiks/${id}/winbox/open`, {}).then((r) => r.data.data);
export const closeWinbox = (id: string) => api.post(`/mikrotiks/${id}/winbox/close`, {}).then((r) => r.data.data);

export const getOnlineSessions = () => api.get('/online-sessions').then((r) => r.data.data);

export interface TenantAnalytics {
  period: string;
  totalRevenue: number;
  paymentTrend: { label: string; amount: number; count: number }[];
  topByUsers: { name: string; value: number }[];
  topByIncome: { name: string; value: number }[];
  topUsers: { username: string; up: number; down: number; total: number }[];
  dataByService: { PPPOE: number; STATIC: number; HOTSPOT: number };
}
export const getAnalytics = (period: string) =>
  api.get(`/analytics/overview?period=${period}`).then((r) => r.data.data as TenantAnalytics);

export const getTenants = () => api.get('/tenants').then((r) => r.data.data);
export const getSidebarCounts = () => api.get('/subscribers/counts').then((r) => r.data.data as { total: number; active: number; routers: number; online: number });
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
export const createSystemUser = (data: { name: string; email: string; phone?: string; role: string }) => api.post('/users', data).then((r) => r.data.data);
export const updateSystemUser = (id: string, data: { name?: string; phone?: string; role?: string; isActive?: boolean }) => api.put(`/users/${id}`, data).then((r) => r.data.data);
export const resetSystemUserPassword = (id: string) => api.post(`/users/${id}/reset-password`, {}).then((r) => r.data.data);
export const changeSystemUserPassword = (id: string, newPassword: string, currentPassword?: string) =>
  api.post(`/users/${id}/change-password`, { newPassword, currentPassword }).then((r) => r.data.data);
export const forgotPassword = (scope: 'STAFF' | 'CUSTOMER', identifier: string, tenantId?: string) =>
  api.post('/auth/forgot-password', { scope, identifier, tenantId }).then((r) => r.data.data);
export const resetPasswordWithCode = (scope: 'STAFF' | 'CUSTOMER', identifier: string, code: string, newPassword: string, tenantId?: string) =>
  api.post('/auth/reset-password', { scope, identifier, code, newPassword, tenantId }).then((r) => r.data.data);
export const deleteSystemUser = (id: string) => api.delete(`/users/${id}`).then((r) => r.data.data);
export const getPaymentConfig = () => api.get('/payment-config').then((r) => r.data.data);
export const updatePaymentConfig = (data: unknown) => api.put('/payment-config', data).then((r) => r.data.data);

export default api;

// Signup
export const signupISP = (data: unknown) => api.post('/signup', data).then(r => r.data.data);
export const checkSubdomain = (name: string) => api.get(`/signup/check-subdomain?name=${encodeURIComponent(name)}`).then(r => r.data.data);
export interface SubdomainResolution { valid: boolean; usable?: boolean; name?: string; subdomain?: string; status?: string }
export const resolveSubdomain = (sub: string) =>
  api.get(`/tenants/resolve?subdomain=${encodeURIComponent(sub)}`).then(r => r.data.data as SubdomainResolution);

// Tenant info
export const getTenantInfo = () => api.get('/tenants/my').then(r => r.data.data);

export interface TenantBranding {
  name: string;
  logoUrl: string | null;
  themeColor: string;
  fontFamily: string;
  supportPhone: string;
  signupPhone: string;
}
export const getBranding = () => api.get('/tenants/branding').then(r => r.data.data as TenantBranding);
export const saveBranding = (data: { themeColor?: string; fontFamily?: string; logoUrl?: string | null; supportPhone?: string }) =>
  api.put('/tenants/branding', data).then(r => r.data.data);

export interface Expense {
  id: string; amount: number; category: string; description?: string | null;
  paymentMode?: string | null; reference?: string | null; source: string; incurredAt: string;
}
export interface ExpenseSummary { total: number; thisMonth: number; byCategory: Record<string, number>; count: number; earnedThisMonth: number; profitThisMonth: number }
export const getExpenses = () => api.get('/expenses').then(r => r.data.data as Expense[]);
export const getExpenseSummary = () => api.get('/expenses/summary').then(r => r.data.data as ExpenseSummary);
export const addExpense = (data: { amount: number; description?: string; paymentMode?: string; reference?: string }) =>
  api.post('/expenses', data).then(r => r.data.data);
export const deleteExpense = (id: string) => api.delete(`/expenses/${id}`).then(r => r.data.data);

// Router actions
export const rebootRouter = (id: string) => api.post(`/mikrotiks/${id}/reboot`).then(r => r.data.data);
export const reprovisionRouter = (id: string) => api.post(`/mikrotiks/${id}/reprovision`).then(r => r.data.data);
export const runRouterCommand = (id: string, command: string) => api.post(`/mikrotiks/${id}/command`, { command }).then(r => r.data.data);
export const changeRouterIdentity = (id: string, identity: string) => api.post(`/mikrotiks/${id}/identity`, { identity }).then(r => r.data.data);
export const updateRouterLanPorts = (id: string, ports: string[]) => api.post(`/mikrotiks/${id}/lan-ports`, { ports }).then(r => r.data.data);
export interface RouterLinkStatus { stage: string; status: string; identity?: string | null; lastSeenAt?: string | null; interfaces: { name: string; type: string }[] }
export const getRouterLinkStatus = (id: string) => api.get(`/mikrotiks/${id}/link-status`).then(r => r.data.data as RouterLinkStatus);
export const getRouterInterfaces = (id: string) => api.get(`/router/list-interfaces/${id}`).then(r => r.data.data);
export const getRouterZtpCommand = (id: string) => api.get(`/mikrotiks/${id}/ztp-command`).then(r => r.data.data);

export interface RouterVpn { provisioned: boolean; wgIp: string | null; endpoint: string; vpnOnline: boolean; lastHandshake?: string | null; mikrotikConfig: string | null; }
export const getRouterVpn = (id: string) => api.get(`/mikrotiks/${id}/vpn`).then(r => r.data.data as RouterVpn);
export const provisionRouterVpn = (id: string) => api.post(`/mikrotiks/${id}/vpn/provision`).then(r => r.data.data as { wgIp: string; endpoint: string; mikrotikConfig: string });

// Vouchers
export const getVouchers = () => api.get('/vouchers').then(r => r.data.data);
export const getVoucherBatches = () => api.get('/vouchers/batches').then(r => r.data.data);
export const generateVouchers = (data: { count: number; packageId?: string; routerId?: string; durationMinutes?: number; codeLength?: number; notes?: string }) =>
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
  toggle: 'sendWelcome' | 'sendPaymentReceipt' | 'sendExpiryReminders' | null;
}
export interface NotificationConfig {
  gateway: 'DARTBIT' | 'CUSTOM';
  provider?: 'BLESSEDTEXTS' | 'TALKSASA';
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
  signupPhone: string | null;
  dartbitAvailable: boolean;
}
export const getNotificationConfig = () =>
  api.get('/notifications/config').then(r => r.data.data as NotificationConfig);
// Save accepts templates as a key->value map (only overrides), plus the other fields.
export const saveNotificationConfig = (data: Record<string, unknown>) =>
  api.put('/notifications/config', data).then(r => r.data.data as NotificationConfig);
export interface SmsBalance {
  mode: 'WALLET' | 'CUSTOM';
  provider?: 'BLESSEDTEXTS' | 'TALKSASA';
  balance: number | null;   // SMS count remaining; null for providers with no balance API (TalkSasa)
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
export interface BroadcastResult { matched: number; sent: number; failed: number }
export const broadcastMessage = (data: { body: string; routerIds?: string[]; services?: string[]; statuses?: string[] }) =>
  api.post('/messages/broadcast', data).then(r => r.data.data as BroadcastResult);

export interface Announcement { id: string; title: string; body: string; level: 'INFO' | 'WARNING' | 'CRITICAL'; createdAt: string; }
export const getAnnouncements = () => api.get('/announcements').then((r) => r.data.data as Announcement[]);

// ---- Network map + plant inventory ----
export interface NetElement { id: string; type: string; name: string; lat: number; lng: number; meta: string | null; photo?: string | null; parentId: string | null; createdAt: string;
  ports?: { total: number; used: number; free: number };
  subscriber?: { id: string; username: string; fullName: string; online: boolean; expired: boolean; isActive: boolean } }
export interface NetCable { id: string; fromId: string; toId: string | null; toLat: number | null; toLng: number | null; lengthM: number; cores: number; powerStartDbm: number | null; powerEndDbm: number | null; isDrop: boolean; label: string | null; status: string; createdAt: string }
export interface NetMaintenance { id: string; cableId: string | null; elementId: string | null; kind: string; note: string | null; newLengthM: number | null; status: string; createdAt: string; createdByName?: string | null }
export const getNetwork = () => api.get('/network').then((r) => r.data.data as { elements: NetElement[]; cables: NetCable[]; maintenance: NetMaintenance[] });
export const addNetElement = (data: { type: string; name?: string; lat: number; lng: number; meta?: Record<string, unknown>; photo?: string; parentId?: string }) => api.post('/network/elements', data).then((r) => r.data.data as { id: string });
export const updateNetElement = (id: string, data: { name?: string; lat?: number; lng?: number; meta?: Record<string, unknown>; photo?: string }) => api.patch(`/network/elements/${id}`, data).then((r) => r.data.data);
export const deleteNetElement = (id: string) => api.delete(`/network/elements/${id}`).then((r) => r.data.data);
export const addNetCable = (data: { fromId: string; toId?: string; toLat?: number; toLng?: number; lengthM: number; cores: number; powerStartDbm?: number; powerEndDbm?: number; isDrop?: boolean; label?: string }) => api.post('/network/cables', data).then((r) => r.data.data as { id: string });
export const deleteNetCable = (id: string) => api.delete(`/network/cables/${id}`).then((r) => r.data.data);
export const addNetMaintenance = (data: { kind: string; cableId?: string; elementId?: string; note?: string; newLengthM?: number }) => api.post('/network/maintenance', data).then((r) => r.data.data);
export const resolveNetMaintenance = (id: string, status: 'CONFIRMED' | 'REJECTED') => api.patch(`/network/maintenance/${id}`, { status }).then((r) => r.data.data);
export const getNetInventory = () => api.get('/network/inventory').then((r) => r.data.data as { routers: number; mikrotiksOnMap: number; olts: number; domes: number; fats: number; patchCords: number; customers: number; cableByCores: { cores: number; runs: number; meters: number }[]; totalCableMeters: number; customerDrops: { count: number; meters: number }; pendingMaintenance: number; splitterPorts: { total: number; used: number; free: number }; fullFats: { id: string; name: string }[] });

// ---- Tenant-initiated M-Pesa prompt (STK push to a subscriber) ----
export interface PromptTarget { subscriberId: string; fullName: string; username: string; phone: string; expired: boolean; expiresAt: string | null; packageId: string | null; packageName: string | null; amount: number | null; hasPackage: boolean }
export const getPromptTarget = (subscriberId: string) => api.get(`/payments/prompt-target/${subscriberId}`).then((r) => r.data.data as PromptTarget);
export const promptPayment = (data: { subscriberId: string; phone?: string; amount?: number }) => api.post('/payments/prompt', data).then((r) => r.data.data as { transactionId: string; phone: string; amount: number; message: string });
export const getPromptStatus = (txId: string) => api.get(`/payments/prompt-status/${txId}`).then((r) => r.data.data as { status: string; message?: string | null; receipt?: string | null; amount?: number });
