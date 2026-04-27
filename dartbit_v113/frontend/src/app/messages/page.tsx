'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMessages, sendMessage } from '@/lib/api';
import AppLayout from '@/components/layout/AppLayout';
import Modal from '@/components/ui/Modal';
import toast from 'react-hot-toast';
import { Plus, MessageSquare } from 'lucide-react';

interface Message { id: string; type: string; recipient: string; body: string; status: string; createdAt: string; }

export default function MessagesPage() {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ type: 'SMS', recipient: '', body: '' });

  const { data: messages = [], isPending } = useQuery({ queryKey: ['messages'], queryFn: getMessages });

  const sendMut = useMutation({
    mutationFn: sendMessage,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['messages'] }); toast.success('Message sent'); setModalOpen(false); setForm({ type: 'SMS', recipient: '', body: '' }); },
    onError: () => toast.error('Failed to send message'),
  });

  return (
    <AppLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Messages</h1>
          <p className="text-sm text-gray-500 mt-1">{(messages as Message[]).length} messages sent</p>
        </div>
        <button onClick={() => setModalOpen(true)} className="btn-primary flex items-center gap-2"><Plus size={16} /> New Message</button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 dark:bg-gray-800/50">
            <tr>
              <th className="table-th">Type</th>
              <th className="table-th">Recipient</th>
              <th className="table-th">Message</th>
              <th className="table-th">Status</th>
              <th className="table-th">Sent At</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {isPending ? (
              <tr><td colSpan={5} className="table-td text-center py-8 text-gray-400">Loading...</td></tr>
            ) : (messages as Message[]).length === 0 ? (
              <tr>
                <td colSpan={5} className="py-16 text-center">
                  <MessageSquare size={40} className="mx-auto text-gray-300 mb-3" />
                  <p className="text-gray-400">No messages yet</p>
                </td>
              </tr>
            ) : (messages as Message[]).map(m => (
              <tr key={m.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                <td className="table-td"><span className="badge-blue">{m.type}</span></td>
                <td className="table-td font-medium">{m.recipient}</td>
                <td className="table-td text-gray-600 dark:text-gray-400 max-w-xs truncate">{m.body}</td>
                <td className="table-td"><span className={m.status === 'SENT' ? 'badge-green' : 'badge-yellow'}>{m.status}</span></td>
                <td className="table-td text-gray-500">{new Date(m.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Send Message">
        <form onSubmit={(e) => { e.preventDefault(); sendMut.mutate(form); }} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Type</label>
              <select className="input" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                <option value="SMS">SMS</option>
                <option value="EMAIL">Email</option>
              </select>
            </div>
            <div>
              <label className="label">Recipient</label>
              <input className="input" value={form.recipient} onChange={e => setForm(f => ({ ...f, recipient: e.target.value }))} placeholder="+254700000000" required />
            </div>
          </div>
          <div>
            <label className="label">Message</label>
            <textarea className="input" rows={4} value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} placeholder="Type your message..." required />
          </div>
          <div className="flex gap-3 justify-end pt-2">
            <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary">Cancel</button>
            <button type="submit" className="btn-primary" disabled={sendMut.isPending}>Send Message</button>
          </div>
        </form>
      </Modal>
    </AppLayout>
  );
}
