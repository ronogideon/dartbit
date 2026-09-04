'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPayments, getPaymentSummary, createPayment, editPayment, deletePayment, getSubscribers, getPromptTarget, promptPayment, getPromptStatus, getPackages, type PromptTarget } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import SubscriberLink from '@/components/ui/SubscriberLink';
import toast from 'react-hot-toast';
import { Plus, Trash2, Edit2, Lock, Smartphone } from 'lucide-react';
import SearchInput from '@/components/ui/SearchInput';
import SearchableSelect from '@/components/ui/SearchableSelect';

interface Payment {
  id: string; amount: number; method: string; source?: string; reference?: string; mpesaCode?: string;
  notes?: string; createdAt: string; subscriber?: { id?: string; fullName: string; username: string };
}
interface Subscriber { id: string; fullName: string; username: string; packageId?: string | null; }
interface Pkg { id: string; name: string; price: number; validityMinutes: number; isActive?: boolean; }

// kind: PACKAGE = payment for an internet package (assigns the package and extends expiry by ITS
// validity). OTHER = anything else (installation, equipment, support) — never touches expiry and
// requires a reason, which is stored in notes.
const emptyForm = { subscriberId: '', amount: '', method: 'MANUAL', reference: '', mpesaCode: '', notes: '', kind: 'PACKAGE' as 'PACKAGE' | 'OTHER', packageId: '' };

// Human-readable validity so the tenant can see what they're granting before recording.
function validityLabel(mins: number): string {
  if (mins % 43200 === 0) return `${mins / 43200} month${mins / 43200 > 1 ? 's' : ''}`;
  if (mins % 1440 === 0) return `${mins / 1440} day${mins / 1440 > 1 ? 's' : ''}`;
  if (mins % 60 === 0) return `${mins / 60} hr`;
  return `${mins} min`;
}

// KES formatter — same as the expenses page tiles for visual consistency.
const kes = (n: number) => `KES ${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

// A payment is automatic when it was created by a gateway (M-Pesa callback); manual when an admin
// recorded it. The backend stamps `source`; we fall back to mpesaCode for any legacy row.
function isAutomatic(p: Payment): boolean {
  return (p.source || (p.mpesaCode ? 'AUTOMATIC' : 'MANUAL')) === 'AUTOMATIC';
}

export default function PaymentsPage() {
  const qc = useQueryClient();
  // --- Prompt payment (tenant-initiated M-Pesa STK push) ---
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptSubId, setPromptSubId] = useState('');
  const [promptTarget, setPromptTarget] = useState<PromptTarget | null>(null);
  const [promptPhone, setPromptPhone] = useState('');
  const [promptAmount, setPromptAmount] = useState('');
  // Which package the prompt is charging for. Prefilled from the subscriber when they have one; the
  // tenant can pick a different one (or one for a subscriber who has none) and the price follows.
  const [promptPackageId, setPromptPackageId] = useState('');
  // True once the tenant types the amount themselves instead of it coming from a package. That's
  // what makes this a non-package payment, so the reason field only appears in that case.
  const [promptAmountManual, setPromptAmountManual] = useState(false);
  const [promptReason, setPromptReason] = useState('');
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptSending, setPromptSending] = useState(false);
  const [promptStatus, setPromptStatus] = useState<string | null>(null);

  const resetPrompt = () => {
    setPromptOpen(false); setPromptSubId(''); setPromptTarget(null);
    setPromptPhone(''); setPromptAmount(''); setPromptStatus(null); setPromptSending(false);
    setPromptPackageId(''); setPromptAmountManual(false); setPromptReason('');
  };

  // Pull the subscriber's saved phone and their package price to prefill the dialog. The tenant can
  // still edit both before sending — e.g. a relative paying on someone else's behalf.
  const loadPromptTarget = async (subId: string) => {
    setPromptSubId(subId);
    setPromptTarget(null); setPromptPhone(''); setPromptAmount(''); setPromptStatus(null);
    setPromptPackageId(''); setPromptAmountManual(false); setPromptReason('');
    if (!subId) return;
    setPromptLoading(true);
    try {
      const t = await getPromptTarget(subId);
      setPromptTarget(t);
      setPromptPhone(t.phone || '');
      setPromptAmount(t.amount != null ? String(t.amount) : '');
      // Preselect their current package so the common case (renew what they're on) needs no picking.
      const sub = (subscribers as Subscriber[]).find(x => x.id === subId);
      if (sub?.packageId) setPromptPackageId(sub.packageId);
    } catch {
      toast.error('Could not load that subscriber');
    } finally {
      setPromptLoading(false);
    }
  };

  const sendPrompt = async () => {
    if (!promptSubId) return toast.error('Choose a subscriber');
    if (!promptPhone.trim()) return toast.error('Enter the phone number to prompt');
    const amt = Number(promptAmount);
    if (!amt || amt <= 0) return toast.error('Enter an amount');
    if (!promptAmountManual && !promptPackageId) return toast.error('Select the package being paid for');
    if (promptAmountManual && !promptReason.trim()) return toast.error('Enter a reason for this payment');
    setPromptSending(true);
    setPromptStatus('Sending request to the phone…');
    try {
      const r = await promptPayment({
        subscriberId: promptSubId,
        phone: promptPhone.trim(),
        amount: amt,
        // A manually-typed amount is not a package renewal, so send the reason instead of a package.
        packageId: promptAmountManual ? undefined : (promptPackageId || undefined),
        notes: promptAmountManual ? promptReason.trim() : undefined,
      });
      setPromptStatus(`Request sent to ${r.phone} — waiting for them to enter their M-Pesa PIN…`);
      // Poll until the customer completes or cancels (STK prompts expire after about a minute).
      const started = Date.now();
      const poll = async (): Promise<void> => {
        if (Date.now() - started > 90_000) { setPromptStatus('No response yet — you can check the Payments list shortly.'); setPromptSending(false); return; }
        await new Promise(res => setTimeout(res, 3000));
        try {
          const st = await getPromptStatus(r.transactionId);
          if (st.status === 'PAID') {
            toast.success('Payment received — subscriber renewed');
            qc.invalidateQueries({ queryKey: ['payments'] });
            qc.invalidateQueries({ queryKey: ['subscribers'] });
            resetPrompt();
            return;
          }
          if (st.status === 'FAILED' || st.status === 'CANCELLED') {
            setPromptStatus(st.message || 'The customer did not complete the payment.');
            setPromptSending(false);
            return;
          }
        } catch { /* keep polling */ }
        return poll();
      };
      void poll();
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not send the request';
      setPromptStatus(msg);
      toast.error(msg);
      setPromptSending(false);
    }
  };

  const [tab, setTab] = useState<'AUTOMATIC' | 'MANUAL'>('AUTOMATIC');
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Payment | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [editForm, setEditForm] = useState({ amount: '', notes: '' });
  const [search, setSearch] = useState('');

  const { data: payments = [], isPending } = useQuery({ queryKey: ['payments'], queryFn: getPayments });
  const { data: summary } = useQuery({ queryKey: ['payment-summary'], queryFn: getPaymentSummary });
  const { data: subscribers = [] } = useQuery({ queryKey: ['subscribers'], queryFn: getSubscribers });
  const { data: packages = [] } = useQuery({ queryKey: ['packages'], queryFn: getPackages });

  const createMut = useMutation({
    mutationFn: createPayment,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payments'] }); qc.invalidateQueries({ queryKey: ['payment-summary'] }); toast.success('Payment recorded'); setModalOpen(false); setForm(emptyForm); setTab('MANUAL'); },
    onError: () => toast.error('Failed to record payment'),
  });
  const editMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { amount?: number; notes?: string } }) => editPayment(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payments'] }); qc.invalidateQueries({ queryKey: ['payment-summary'] }); toast.success('Payment updated'); setEditing(null); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to update payment'),
  });
  const deleteMut = useMutation({
    mutationFn: deletePayment,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payments'] }); qc.invalidateQueries({ queryKey: ['payment-summary'] }); toast.success('Payment deleted'); setDeleteId(null); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to delete payment'),
  });

  // Selecting a subscriber prefills their current package (and therefore the amount), so the common
  // case — renewing the plan they're already on — is a two-click operation.
  const onPickSubscriber = (id: string) => {
    const sub = (subscribers as Subscriber[]).find(x => x.id === id);
    const pkg = sub?.packageId ? (packages as Pkg[]).find(p => p.id === sub.packageId) : undefined;
    setForm(f => ({
      ...f,
      subscriberId: id,
      packageId: pkg ? pkg.id : '',
      amount: f.kind === 'PACKAGE' && pkg ? String(pkg.price) : f.amount,
    }));
  };

  // Choosing a package always refreshes the amount to that package's price.
  const onPickPackage = (pkgId: string) => {
    const pkg = (packages as Pkg[]).find(p => p.id === pkgId);
    setForm(f => ({ ...f, packageId: pkgId, amount: pkg ? String(pkg.price) : f.amount }));
  };

  // Switching to OTHER clears the package attribution and the prefilled amount, because an "other"
  // payment is deliberately not tied to a plan and must not extend expiry.
  const onPickKind = (kind: 'PACKAGE' | 'OTHER') => {
    setForm(f => {
      if (kind === 'OTHER') return { ...f, kind, packageId: '', amount: '' };
      const sub = (subscribers as Subscriber[]).find(x => x.id === f.subscriberId);
      const pkg = sub?.packageId ? (packages as Pkg[]).find(p => p.id === sub.packageId) : undefined;
      return { ...f, kind, packageId: pkg ? pkg.id : '', amount: pkg ? String(pkg.price) : '' };
    });
  };

  const selectedPkg = (packages as Pkg[]).find(p => p.id === form.packageId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (form.kind === 'PACKAGE' && !form.packageId) {
      return toast.error('Select the package being paid for, or switch to Other payment');
    }
    if (form.kind === 'OTHER' && !form.notes.trim()) {
      return toast.error('Enter a reason for this payment');
    }
    createMut.mutate({
      subscriberId: form.subscriberId,
      amount: Number(form.amount),
      method: form.method,
      kind: form.kind,
      packageId: form.kind === 'PACKAGE' ? form.packageId : undefined,
      reference: form.reference || undefined,
      mpesaCode: form.mpesaCode || undefined,
      notes: form.notes || undefined,
    });
  };

  const openEdit = (p: Payment) => { setEditing(p); setEditForm({ amount: String(p.amount), notes: p.notes || '' }); };
  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    editMut.mutate({ id: editing.id, data: { amount: Number(editForm.amount), notes: editForm.notes || undefined } });
  };

  const list = payments as Payment[];
  const automatic = list.filter(isAutomatic);
  const manual = list.filter(p => !isAutomatic(p));
  const total = list.reduce((s, p) => s + p.amount, 0);

  const q = search.trim().toLowerCase();
  const match = (p: Payment) => !q ||
    (p.subscriber?.fullName || '').toLowerCase().includes(q) ||
    (p.subscriber?.username || '').toLowerCase().includes(q) ||
    (p.reference || '').toLowerCase().includes(q) ||
    (p.method || '').toLowerCase().includes(q) ||
    String(p.amount).includes(q);

  const rows = (tab === 'AUTOMATIC' ? automatic : manual).filter(match);

  const TABS = [
    { key: 'AUTOMATIC' as const, label: 'Automatic', count: automatic.length },
    { key: 'MANUAL' as const, label: 'Manual', count: manual.length },
  ];

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Payments</h1>
          <p className="text-sm text-gray-500 mt-1">Total collected: KES {total.toLocaleString()}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setPromptOpen(true)} className="btn-secondary flex items-center gap-2"><Smartphone size={16} /> Prompt Payment</button>
          <button onClick={() => setModalOpen(true)} className="btn-primary flex items-center gap-2"><Plus size={16} /> Record Payment</button>
        </div>
      </div>

      {/* Earnings summary tiles — week starts Monday, month from the 1st; all services except the hotspot tile */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="card p-5">
          <div className="text-sm text-gray-500 mb-1">Earned Today</div>
          <div className="text-2xl font-bold">{kes(summary?.earnedToday || 0)}</div>
          <div className="text-xs text-gray-400 mt-1">All services</div>
        </div>
        <div className="card p-5">
          <div className="text-sm text-gray-500 mb-1">Today — Hotspot</div>
          <div className="text-2xl font-bold">{kes(summary?.todayHotspot || 0)}</div>
          <div className="text-xs text-gray-400 mt-1">Hotspot only</div>
        </div>
        <div className="card p-5">
          <div className="text-sm text-gray-500 mb-1">This Week</div>
          <div className="text-2xl font-bold">{kes(summary?.thisWeek || 0)}</div>
          <div className="text-xs text-gray-400 mt-1">Since Monday</div>
        </div>
        <div className="card p-5">
          <div className="text-sm text-gray-500 mb-1">This Month</div>
          <div className="text-2xl font-bold">{kes(summary?.thisMonth || 0)}</div>
          <div className="text-xs text-gray-400 mt-1">Since the 1st</div>
        </div>
      </div>

      {/* Automatic vs Manual tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200 dark:border-gray-800">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px flex items-center gap-2 transition ${tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}>
            {t.label}
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${tab === t.key ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}>{t.count}</span>
          </button>
        ))}
      </div>

      <div className="mb-4 max-w-md">
        <SearchInput value={search} onChange={setSearch} placeholder="Search by subscriber, reference, method, amount…" />
      </div>

      {tab === 'AUTOMATIC' && (
        <p className="text-xs text-gray-500 mb-3 flex items-center gap-1.5"><Lock size={12} /> Automatic payments come from the M-Pesa gateway and are a permanent record — they can't be edited or deleted.</p>
      )}

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-gray-800/50">
            <tr>
              <th className="table-th">Subscriber</th>
              <th className="table-th">Amount (KES)</th>
              <th className="table-th">Method</th>
              <th className="table-th">Reference</th>
              <th className="table-th">Date</th>
              <th className="table-th">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {isPending ? (
              <tr><td colSpan={6} className="table-td text-center py-8 text-gray-400">Loading...</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="table-td text-center py-8 text-gray-400">No {tab.toLowerCase()} payments</td></tr>
            ) : rows.map(p => (
              <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                <td className="table-td">
                  <p className="font-medium"><SubscriberLink id={p.subscriber?.id} name={p.subscriber?.fullName} /></p>
                  <p className="text-xs text-gray-500">{p.subscriber?.username}</p>
                </td>
                <td className="table-td font-semibold text-green-600">{p.amount.toLocaleString()}</td>
                <td className="table-td"><span className="badge-blue">{p.method}</span></td>
                <td className="table-td text-gray-500">{p.reference || '-'}</td>
                <td className="table-td text-gray-500">{new Date(p.createdAt).toLocaleString()}</td>
                <td className="table-td">
                  {isAutomatic(p) ? (
                    <span className="text-xs text-gray-400 flex items-center gap-1"><Lock size={13} /> Locked</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(p)} className="p-1.5 text-gray-400 hover:text-blue-600" title="Edit amount / notes"><Edit2 size={15} /></button>
                      <button onClick={() => setDeleteId(p.id)} className="p-1.5 text-gray-400 hover:text-red-600" title="Delete"><Trash2 size={15} /></button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Record (manual) payment */}
      <Modal isOpen={modalOpen} onClose={() => { setModalOpen(false); setForm(emptyForm); }} title="Record Payment">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Subscriber</label>
            <select className="input" value={form.subscriberId} onChange={e => onPickSubscriber(e.target.value)} required>
              <option value="">-- Select Subscriber --</option>
              {(subscribers as Subscriber[]).map(s => <option key={s.id} value={s.id}>{s.fullName} ({s.username})</option>)}
            </select>
          </div>

          {/* What is being paid for. Package is the default: it assigns the plan and extends expiry
              by that plan's validity. Other is for non-package income and never touches expiry. */}
          <div>
            <label className="label">Payment for</label>
            <div className="flex gap-2">
              <button type="button" onClick={() => onPickKind('PACKAGE')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm border transition-colors ${form.kind === 'PACKAGE' ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300'}`}>
                Internet package
              </button>
              <button type="button" onClick={() => onPickKind('OTHER')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm border transition-colors ${form.kind === 'OTHER' ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300'}`}>
                Other payment
              </button>
            </div>
          </div>

          {form.kind === 'PACKAGE' && (
            <div>
              <label className="label">Package</label>
              <select className="input" value={form.packageId} onChange={e => onPickPackage(e.target.value)} required>
                <option value="">-- Select Package --</option>
                {(packages as Pkg[]).filter(p => p.isActive !== false).map(p => (
                  <option key={p.id} value={p.id}>{p.name} — KES {p.price.toLocaleString()} / {validityLabel(p.validityMinutes)}</option>
                ))}
              </select>
              {selectedPkg && (
                <p className="text-xs text-gray-500 mt-1">
                  Extends expiry by {validityLabel(selectedPkg.validityMinutes)} and sets this as the subscriber&apos;s package.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Amount (KES)</label>
              <input className="input" type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required min={0} />
            </div>
            <div>
              <label className="label">Payment Method</label>
              <select className="input" value={form.method} onChange={e => setForm(f => ({ ...f, method: e.target.value }))}>
                <option value="MANUAL">Manual</option>
                <option value="MPESA">M-Pesa</option>
                <option value="BANK">Bank Transfer</option>
                <option value="CASH">Cash</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Reference</label>
              <input className="input" value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="label">{form.kind === 'OTHER' ? 'Reason for payment' : 'Notes'}</label>
            <textarea
              className="input"
              rows={2}
              required={form.kind === 'OTHER'}
              placeholder={form.kind === 'OTHER' ? 'e.g. Installation fee, router purchase, relocation…' : 'Optional'}
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            />
            {form.kind === 'OTHER' && (
              <p className="text-xs text-gray-500 mt-1">This payment will not change the subscriber&apos;s expiry.</p>
            )}
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary" disabled={createMut.isPending}>Record Payment</button>
          </div>
        </form>
      </Modal>

      {/* Prompt payment — tenant-initiated M-Pesa STK push to the subscriber's phone */}
      <Modal isOpen={promptOpen} onClose={resetPrompt} title="Prompt Payment">
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            Sends an M-Pesa request to the subscriber&apos;s phone. They approve it with their PIN and the
            renewal is applied automatically.
          </p>

          <div>
            <label className="label">Subscriber</label>
            <SearchableSelect
              placeholder="Search a subscriber by name or username…"
              value={promptSubId}
              onChange={(v) => loadPromptTarget(String(v))}
              options={[...(subscribers as Subscriber[])]
                .sort((a, b) => a.fullName.localeCompare(b.fullName))
                .map(sub => ({ value: sub.id, label: `${sub.fullName} (${sub.username})` }))}
            />
          </div>

          {promptLoading && <p className="text-sm text-gray-400">Loading their details…</p>}

          {promptTarget && (
            <>
              <div className="rounded-lg bg-gray-50 dark:bg-gray-800/60 p-3 text-sm">
                {promptTarget.hasPackage ? (
                  <p>
                    Package: <span className="font-medium">{promptTarget.packageName}</span>
                    {promptTarget.expired
                      ? <span className="text-red-500"> · expired — charging their previous package</span>
                      : <span className="text-green-600"> · active</span>}
                  </p>
                ) : (
                  <p className="text-amber-600">No package assigned — pick one below, or type an amount for another service.</p>
                )}
              </div>

              <div>
                <label className="label">Phone to prompt</label>
                <input className="input" value={promptPhone} onChange={e => setPromptPhone(e.target.value)}
                  placeholder="07XXXXXXXX" disabled={promptSending} />
                <p className="text-[11px] text-gray-400 mt-1">
                  {promptTarget.phone ? 'From their saved details — edit if someone else is paying.' : 'No number saved for this subscriber.'}
                </p>
              </div>

              {/* Package drives the amount. Works whether or not the subscriber already has one. */}
              <div>
                <label className="label">Package</label>
                <select
                  className="input"
                  value={promptAmountManual ? '' : promptPackageId}
                  disabled={promptSending}
                  onChange={e => {
                    const id = e.target.value;
                    const pkg = (packages as Pkg[]).find(p => p.id === id);
                    setPromptPackageId(id);
                    // Selecting a package fills the price and returns this to a package payment.
                    setPromptAmountManual(false);
                    setPromptReason('');
                    if (pkg) setPromptAmount(String(pkg.price));
                  }}
                >
                  <option value="">-- Select Package --</option>
                  {(packages as Pkg[]).filter(p => p.isActive !== false).map(p => (
                    <option key={p.id} value={p.id}>{p.name} — KES {p.price.toLocaleString()} / {validityLabel(p.validityMinutes)}</option>
                  ))}
                </select>
                {!promptAmountManual && promptPackageId && (() => {
                  const pkg = (packages as Pkg[]).find(p => p.id === promptPackageId);
                  return pkg ? <p className="text-[11px] text-gray-400 mt-1">On payment: extends expiry by {validityLabel(pkg.validityMinutes)}.</p> : null;
                })()}
              </div>

              <div>
                <label className="label">Amount (KES)</label>
                <input className="input" type="number" min={1} value={promptAmount}
                  onChange={e => {
                    setPromptAmount(e.target.value);
                    // Typing the amount means this isn't a package renewal — reveal the reason field.
                    setPromptAmountManual(true);
                    setPromptPackageId('');
                  }}
                  disabled={promptSending} />
                <p className="text-[11px] text-gray-400 mt-1">
                  {promptAmountManual
                    ? 'Manual amount — this will not change their expiry.'
                    : 'From the selected package — type a different amount to charge for another service.'}
                </p>
              </div>

              {/* Only shown for a manually-entered amount; required before the prompt can be sent. */}
              {promptAmountManual && (
                <div>
                  <label className="label">Reason for payment</label>
                  <input
                    className="input"
                    value={promptReason}
                    onChange={e => setPromptReason(e.target.value)}
                    placeholder="e.g. Installation fee, router purchase, relocation…"
                    disabled={promptSending}
                  />
                </div>
              )}
            </>
          )}

          {promptStatus && (
            <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3 text-sm">
              {promptStatus}
            </div>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={resetPrompt} className="btn-secondary">
              {promptSending ? 'Close' : 'Cancel'}
            </button>
            <button type="button" onClick={sendPrompt} className="btn-primary flex items-center gap-2"
              disabled={
                promptSending || !promptTarget ||
                (!promptAmountManual && !promptPackageId) ||
                (promptAmountManual && !promptReason.trim())
              }>
              <Smartphone size={16} /> {promptSending ? 'Waiting…' : 'Send request'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Edit manual payment — amount + notes only */}
      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title="Edit Payment">
        <form onSubmit={handleEditSubmit} className="space-y-4">
          <div>
            <label className="label">Amount (KES)</label>
            <input className="input" type="number" value={editForm.amount} onChange={e => setEditForm(f => ({ ...f, amount: e.target.value }))} required min={0} />
          </div>
          <div>
            <label className="label">Notes</label>
            <textarea className="input" rows={3} value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setEditing(null)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary" disabled={editMut.isPending}>Save Changes</button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog isOpen={!!deleteId} onClose={() => setDeleteId(null)}
        onConfirm={() => deleteId && deleteMut.mutate(deleteId)} loading={deleteMut.isPending} />
    </AppLayout>
  );
}
