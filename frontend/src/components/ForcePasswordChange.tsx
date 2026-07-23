'use client';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { changeSystemUserPassword } from '@/lib/api';
import toast from 'react-hot-toast';
import { KeyRound, Eye, EyeOff } from 'lucide-react';

// Shown when a staff account logged in with a TEMPORARY password (mustChangePassword).
// The person can set a new password, or skip once — the prompt returns on the next login
// until the password is actually changed.
export default function ForcePasswordChange() {
  const { user, clearMustChangePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!user?.mustChangePassword) return null;

  const problem =
    next.length > 0 && next.length < 6 ? 'Use at least 6 characters'
      : confirm.length > 0 && next !== confirm ? 'The two passwords do not match'
        : '';
  const ready = !!current && next.length >= 6 && next === confirm && !saving;

  const submit = async () => {
    if (!ready || !user) return;
    setSaving(true);
    try {
      await changeSystemUserPassword(user.id, next, current);
      clearMustChangePassword();
      toast.success('Password updated — use it next time you sign in.');
    } catch (e) {
      toast.error((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not change the password');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[2000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
            <KeyRound size={18} className="text-blue-600" />
          </span>
          <h2 className="text-lg font-bold">Set a new password</h2>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          You signed in with a temporary password. Choose one only you know.
        </p>

        <label className="label text-xs">Temporary password</label>
        <input className="input mb-2" type={show ? 'text' : 'password'} value={current}
          onChange={e => setCurrent(e.target.value)} placeholder="the one sent by SMS" autoFocus />

        <label className="label text-xs">New password</label>
        <input className="input mb-2" type={show ? 'text' : 'password'} value={next}
          onChange={e => setNext(e.target.value)} placeholder="at least 6 characters" />

        <label className="label text-xs">Confirm new password</label>
        <input className="input" type={show ? 'text' : 'password'} value={confirm}
          onChange={e => setConfirm(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && ready) submit(); }} />

        <button type="button" onClick={() => setShow(s => !s)}
          className="mt-2 text-xs text-gray-500 flex items-center gap-1.5 hover:text-gray-700 dark:hover:text-gray-300">
          {show ? <EyeOff size={13} /> : <Eye size={13} />} {show ? 'Hide' : 'Show'} passwords
        </button>

        {problem && <p className="text-xs text-red-500 mt-2">{problem}</p>}

        <div className="flex items-center gap-2 mt-4">
          <button type="button" onClick={clearMustChangePassword} className="btn-secondary text-sm">
            Skip for now
          </button>
          <button type="button" onClick={submit} disabled={!ready} className="btn-primary text-sm flex-1 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save password'}
          </button>
        </div>
        <p className="text-[11px] text-gray-400 mt-2">
          Skipping keeps the temporary password working — you&apos;ll be asked again next time you sign in.
        </p>
      </div>
    </div>
  );
}
