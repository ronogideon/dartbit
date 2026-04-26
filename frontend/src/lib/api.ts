import axios from 'axios';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://dartbit-production.up.railway.app';

const api = axios.create({ baseURL: BASE_URL });

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('dartbit_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
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

export const getPackages = () => api.get('/packages').then((r) => r.data.data);
export const createPackage = (data: unknown) => api.post('/packages', data).then((r) => r.data.data);
export const updatePackage = (id: string, data: unknown) => api.put(`/packages/${id}`, data).then((r) => r.data.data);
export const deletePackage = (id: string) => api.delete(`/packages/${id}`).then((r) => r.data.data);

export const getPayments = () => api.get('/payments').then((r) => r.data.data);
export const createPayment = (data: unknown) => api.post('/payments', data).then((r) => r.data.data);
export const deletePayment = (id: string) => api.delete(`/payments/${id}`).then((r) => r.data.data);

export const getMessages = () => api.get('/messages').then((r) => r.data.data);
export const sendMessage = (data: unknown) => api.post('/messages', data).then((r) => r.data.data);

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

export default api;
