'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from '@/lib/auth';
import SubdomainGuard from '@/components/SubdomainGuard';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: 1, staleTime: 30000 } },
  }));

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SubdomainGuard>{children}</SubdomainGuard>
        <Toaster position="top-right" toastOptions={{
          style: { background: '#1f2937', color: '#f9fafb', borderRadius: '8px' },
        }} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
