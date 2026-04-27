'use client';
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSettings, updateSettings } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import toast from 'react-hot-toast';

interface Settings {
  currency?: string; timezone?: string; backendUrl?: string;
  smsSenderId?: string; smsApiKey?: string; emailFromAddress?: string;
}

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  const [form, setForm] = useState<Settings>({
    currency: 'KES', timezone: 'Africa/Nairobi', backendUrl: '', smsSenderId: '', smsApiKey: '', emailFromAddress: '',
  });

  useEffect(() => {
    if (settings) setForm(settings as Settings);
  }, [settings]);

  const updateMut = useMutation({
    mutationFn: updateSettings,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); toast.success('Settings saved'); },
    onError: () => toast.error('Failed to save settings'),
  });

  if (isLoading) return <AppLayout><div className="text-center py-8 text-gray-400">Loading...</div></AppLayout>;

  return (
    <AppLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-gray-500 mt-1">Configure your ISP platform settings</p>
      </div>

      <div className="max-w-2xl space-y-6">
        <div className="card p-6">
          <h2 className="font-semibold mb-4">General</h2>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Currency</label>
                <input className="input" value={form.currency || ''} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))} />
              </div>
              <div>
                <label className="label">Timezone</label>
                <input className="input" value={form.timezone || ''} onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="label">Backend URL (for MikroTik ZTP)</label>
              <input className="input" value={form.backendUrl || ''} onChange={e => setForm(f => ({ ...f, backendUrl: e.target.value }))} placeholder="https://api.yourdomain.com" />
            </div>
          </div>
        </div>

        <div className="card p-6">
          <h2 className="font-semibold mb-4">SMS Configuration</h2>
          <div className="space-y-4">
            <div>
              <label className="label">SMS Sender ID</label>
              <input className="input" value={form.smsSenderId || ''} onChange={e => setForm(f => ({ ...f, smsSenderId: e.target.value }))} placeholder="DARTBIT" />
            </div>
            <div>
              <label className="label">SMS API Key</label>
              <input className="input" type="password" value={form.smsApiKey || ''} onChange={e => setForm(f => ({ ...f, smsApiKey: e.target.value }))} placeholder="Your SMS provider API key" />
            </div>
          </div>
        </div>

        <div className="card p-6">
          <h2 className="font-semibold mb-4">Email Configuration</h2>
          <div>
            <label className="label">From Email Address</label>
            <input className="input" type="email" value={form.emailFromAddress || ''} onChange={e => setForm(f => ({ ...f, emailFromAddress: e.target.value }))} placeholder="noreply@yourdomain.com" />
          </div>
        </div>

        <button onClick={() => updateMut.mutate(form)} disabled={updateMut.isPending} className="btn-primary w-full">
          {updateMut.isPending ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </AppLayout>
  );
}
