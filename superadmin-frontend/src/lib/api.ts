import axios from 'axios';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://api.dartbittech.com';
const api = axios.create({ baseURL: BASE_URL });

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('dartbit_sa_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default api;

export const login = (email: string, password: string) =>
  api.post('/auth/login', { email, password }).then((r) => r.data.data);
export const getOverview = (range = 'all') => api.get('/superadmin/overview', { params: { range } }).then((r) => r.data.data);
export const getTenants = () => api.get('/superadmin/tenants').then((r) => r.data.data);
export const getPayouts = () => api.get('/superadmin/payouts').then((r) => r.data.data);
export const getTeam = () => api.get('/superadmin/team').then((r) => r.data.data);
export const createTeamMember = (data: { name: string; email: string; role: string }) => api.post('/superadmin/team', data).then((r) => r.data.data);
export const updateTeamMember = (id: string, data: { role?: string; isActive?: boolean }) => api.put(`/superadmin/team/${id}`, data).then((r) => r.data.data);
export const resetTeamPassword = (id: string) => api.post(`/superadmin/team/${id}/reset-password`, {}).then((r) => r.data.data);
export const deleteTeamMember = (id: string) => api.delete(`/superadmin/team/${id}`).then((r) => r.data.data);
export const getSmsRate = () => api.get('/superadmin/sms-rate').then((r) => r.data.data as { rate: number });
export const setSmsRate = (rate: number) => api.put('/superadmin/sms-rate', { rate }).then((r) => r.data.data as { rate: number });

export interface MsgTenantRow { tenantId: string; name: string; subdomain: string; balanceKes: number; units: number; spentKes: number; sentThisMonth: number; sentLifetime: number }
export interface MsgOverview {
  rate: number;
  gatewayBalance: number | null;
  defaultProvider: 'BLESSEDTEXTS' | 'TALKSASA';
  totals: { sentThisMonth: number; sentLifetime: number; totalUnits: number; totalBalanceKes: number };
  tenants: MsgTenantRow[];
}
export interface MsgTemplate { key: string; group: string; label: string; description: string; body: string; isDefault: boolean; editable: boolean; placeholders: string[] }
export const getMessagingOverview = () => api.get('/superadmin/messaging/overview').then((r) => r.data.data as MsgOverview);
export const getMessagingProvider = () => api.get('/superadmin/messaging/provider').then((r) => r.data.data as { provider: 'BLESSEDTEXTS' | 'TALKSASA'; configured: { BLESSEDTEXTS: boolean; TALKSASA: boolean } });
export const setMessagingProvider = (provider: 'BLESSEDTEXTS' | 'TALKSASA') => api.put('/superadmin/messaging/provider', { provider }).then((r) => r.data.data);
export const getMessagingTemplates = () => api.get('/superadmin/messaging/templates').then((r) => r.data.data as { templates: MsgTemplate[] });
export const saveMessagingTemplate = (key: string, body: string) => api.put(`/superadmin/messaging/templates/${key}`, { body }).then((r) => r.data.data);

// Central Dartbit payments master switch + platform income stats
export const getCentralPayments = () => api.get('/superadmin/central-payments').then((r) => r.data.data as { enabled: boolean });
export const setCentralPayments = (enabled: boolean) => api.put('/superadmin/central-payments', { enabled }).then((r) => r.data.data as { enabled: boolean });
export const getPaymentStats = () => api.get('/superadmin/payments/stats').then((r) => r.data.data);

// Tenant lifecycle
export const setTenantStatus = (id: string, status: 'ACTIVE' | 'SUSPENDED') => api.put(`/superadmin/tenants/${id}/status`, { status }).then((r) => r.data.data);
export const deleteTenant = (id: string, confirmName: string) => api.delete(`/superadmin/tenants/${id}`, { data: { confirmName } }).then((r) => r.data.data);

export interface AdminAnnouncement { id: string; title: string; body: string; level: 'INFO'|'WARNING'|'CRITICAL'; active: boolean; createdAt: string; expiresAt: string|null; }
export const listAnnouncements = () => api.get('/announcements/all').then((r) => r.data.data as AdminAnnouncement[]);
export const createAnnouncement = (data: { title: string; body: string; level: string; expiresAt?: string|null }) => api.post('/announcements', data).then((r) => r.data.data);
export const toggleAnnouncement = (id: string, active: boolean) => api.patch(`/announcements/${id}`, { active }).then((r) => r.data.data);
export const deleteAnnouncement = (id: string) => api.delete(`/announcements/${id}`).then((r) => r.data.data);
