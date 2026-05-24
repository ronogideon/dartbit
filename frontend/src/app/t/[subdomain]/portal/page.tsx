'use client';
import { useParams } from 'next/navigation';
import PortalApp from '@/components/PortalApp';

export default function TenantPortal() {
  const params = useParams();
  const subdomain = String(params?.subdomain || '');
  return <PortalApp subdomain={subdomain} />;
}
