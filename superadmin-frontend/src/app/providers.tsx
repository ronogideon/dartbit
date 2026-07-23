'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { useState } from 'react';
import SessionExpiredLock from '@/components/SessionExpiredLock';

export default function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={qc}>
      {children}
      <SessionExpiredLock />
      <Toaster position="top-right" />
    </QueryClientProvider>
  );
}
