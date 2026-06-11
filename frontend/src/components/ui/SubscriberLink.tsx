'use client';
import Link from 'next/link';

// Renders a subscriber's name as a link to their details on the Subscribers page. The page reads
// the ?focus=<id> param on load and opens that subscriber's detail panel. Use anywhere a subscriber
// is referenced (payments, dashboard, etc.) so users are always one tap from their full record.
// Falls back to plain text when no id is available (e.g. a deleted subscriber).
export default function SubscriberLink({
  id, name, className = '',
}: { id?: string | null; name?: string | null; className?: string }) {
  const label = name || 'Unknown';
  if (!id) return <span className={className}>{label}</span>;
  return (
    <Link href={`/subscribers?focus=${id}`} className={`text-blue-600 hover:underline ${className}`}>
      {label}
    </Link>
  );
}
